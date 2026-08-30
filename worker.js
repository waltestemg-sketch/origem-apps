// ORIGEM — Worker principal
// Serve o site estático (via ASSETS) e expõe:
//   POST /api/contact          -> salva mensagem do formulário público
//   GET  /admin/api/messages   -> lista mensagens (protegido por senha)
//   POST /admin/api/publish    -> publica um app novo (protegido por senha)

const OWNER = "waltestemg-sketch";
const REPO = "origem-apps";
const BRANCH = "main";
const GH_API = "https://api.github.com";

function ghHeaders(env, extra = {}) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "origem-apps-worker",
    "Accept": "application/vnd.github+json",
    ...extra,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function checkAuth(request, env) {
  const pass = request.headers.get("X-Admin-Password") || "";
  return pass && env.ADMIN_PASSWORD && pass === env.ADMIN_PASSWORD;
}

// ---------- helpers GitHub ----------

async function getFile(env, path) {
  const res = await fetch(
    `${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders(env) }
  );
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw new Error(`Falha ao ler ${path}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = decodeURIComponent(
    atob(data.content.replace(/\n/g, ""))
      .split("")
      .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
  );
  return { content, sha: data.sha };
}

async function putFile(env, path, contentStr, sha, message) {
  const b64 = btoa(
    encodeURIComponent(contentStr).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  );
  const body = {
    message,
    content: b64,
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Falha ao gravar ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function putBinaryFile(env, path, arrayBuffer, sha, message) {
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  const body = { message, content: b64, branch: BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Falha ao gravar ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getOrCreateRelease(env, tag, name) {
  let res = await fetch(
    `${GH_API}/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: ghHeaders(env) }
  );
  if (res.status === 200) return res.json();
  res = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/releases`, {
    method: "POST",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ tag_name: tag, name, target_commitish: BRANCH }),
  });
  if (!res.ok) throw new Error(`Falha ao criar release: ${res.status} ${await res.text()}`);
  return res.json();
}

async function uploadReleaseAsset(env, release, filename, arrayBuffer, contentType) {
  const uploadUrl = release.upload_url.replace("{?name,label}", "");
  const res = await fetch(`${uploadUrl}?name=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: ghHeaders(env, { "Content-Type": contentType || "application/octet-stream" }),
    body: arrayBuffer,
  });
  if (!res.ok) throw new Error(`Falha ao subir asset: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- rotas ----------

async function handleContact(request) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const { name, email, whatsapp, message } = data;
  if (!name || !email || !whatsapp || !message) {
    return json({ error: "Preencha todos os campos." }, 400);
  }
  return { name, email, whatsapp, message };
}

async function handlePublicContact(request, env) {
  const parsed = await handleContact(request);
  if (parsed instanceof Response) return parsed;

  const { content, sha } = await getFile(env, "data/messages.json");
  let messages = [];
  try {
    messages = content ? JSON.parse(content) : [];
  } catch {
    messages = [];
  }
  messages.unshift({
    id: crypto.randomUUID(),
    name: parsed.name,
    email: parsed.email,
    whatsapp: parsed.whatsapp,
    message: parsed.message,
    date: new Date().toISOString(),
    read: false,
  });
  await putFile(
    env,
    "data/messages.json",
    JSON.stringify(messages, null, 2),
    sha,
    `Nova mensagem de contato de ${parsed.name}`
  );
  return json({ ok: true });
}

async function handleListMessages(request, env) {
  if (!checkAuth(request, env)) return json({ error: "Não autorizado" }, 401);
  const { content } = await getFile(env, "data/messages.json");
  let messages = [];
  try {
    messages = content ? JSON.parse(content) : [];
  } catch {
    messages = [];
  }
  return json({ messages });
}

async function handleMarkRead(request, env, id) {
  if (!checkAuth(request, env)) return json({ error: "Não autorizado" }, 401);
  const { content, sha } = await getFile(env, "data/messages.json");
  let messages = content ? JSON.parse(content) : [];
  messages = messages.map((m) => (m.id === id ? { ...m, read: true } : m));
  await putFile(env, "data/messages.json", JSON.stringify(messages, null, 2), sha, `Mensagem marcada como lida`);
  return json({ ok: true });
}

async function handleDeleteMessage(request, env, id) {
  if (!checkAuth(request, env)) return json({ error: "Não autorizado" }, 401);
  const { content, sha } = await getFile(env, "data/messages.json");
  let messages = content ? JSON.parse(content) : [];
  messages = messages.filter((m) => m.id !== id);
  await putFile(env, "data/messages.json", JSON.stringify(messages, null, 2), sha, `Mensagem removida`);
  return json({ ok: true });
}

async function handlePublish(request, env) {
  if (!checkAuth(request, env)) return json({ error: "Não autorizado" }, 401);

  const form = await request.formData();
  const id = (form.get("id") || "").toString().trim();
  const name = (form.get("name") || "").toString().trim();
  const version = (form.get("version") || "").toString().trim();
  const cat = (form.get("cat") || "Ferramentas").toString().trim();
  const androidMin = (form.get("android") || "Android 8.0+").toString().trim();
  const desc = (form.get("desc") || "").toString().trim();
  const changesRaw = (form.get("changes") || "").toString().trim();
  const developer = (form.get("developer") || "ORIGEM").toString().trim();
  const packageId = (form.get("packageId") || "").toString().trim();
  const apkFile = form.get("apk");
  const iconFile = form.get("icon");

  if (!id || !name || !version || !desc || !apkFile) {
    return json({ error: "Faltam campos obrigatórios (id, nome, versão, descrição, APK)." }, 400);
  }

  const tag = `${id}-v${version}`;
  const release = await getOrCreateRelease(env, tag, `${name} v${version}`);

  const apkBuffer = await apkFile.arrayBuffer();
  const apkFilename = apkFile.name || `${id}-v${version}.apk`;
  await uploadReleaseAsset(env, release, apkFilename, apkBuffer, "application/vnd.android.package-archive");
  const apkSizeMB = (apkBuffer.byteLength / (1024 * 1024)).toFixed(2).replace(".", ",") + " MB";

  let iconPath = null;
  if (iconFile && iconFile.size > 0) {
    const ext = (iconFile.name || "icon.webp").split(".").pop();
    iconPath = `assets/apps/${id}/icon.${ext}`;
    const iconBuffer = await iconFile.arrayBuffer();
    const existing = await getFile(env, iconPath).catch(() => ({ sha: null }));
    await putBinaryFile(env, iconPath, iconBuffer, existing.sha, `Ícone de ${name} v${version}`);
  }

  const { content, sha } = await getFile(env, "data/apps.json");
  let apps = content ? JSON.parse(content) : [];
  apps = apps.filter((a) => a.id !== id);

  const today = new Date();
  const dateStr = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;

  apps.push({
    id,
    name,
    short: name.slice(0, 2).toUpperCase(),
    icon: iconPath || "assets/icons/default.png",
    cat,
    version,
    size: apkSizeMB,
    android: androidMin,
    date: dateStr,
    rating: null,
    downloads: "Novo",
    featured: true,
    desc,
    apk: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${apkFilename}`,
    changes: changesRaw ? changesRaw.split("\n").map((s) => s.trim()).filter(Boolean) : [],
    installNote:
      "Por ser um APK instalado fora da loja, o Android pode pedir autorização para instalar apps desconhecidos. Essa autorização é do Android, não da Origem.",
    setup: [],
    releaseAssetName: apkFilename,
    developer,
    packageId,
  });

  await putFile(env, "data/apps.json", JSON.stringify(apps, null, 2), sha, `Publica ${name} v${version} via painel`);

  return json({ ok: true, apk: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${apkFilename}` });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/contact" && request.method === "POST") {
        return await handlePublicContact(request, env);
      }
      if (pathname === "/admin/api/messages" && request.method === "GET") {
        return await handleListMessages(request, env);
      }
      const readMatch = pathname.match(/^\/admin\/api\/messages\/([^/]+)\/read$/);
      if (readMatch && request.method === "POST") {
        return await handleMarkRead(request, env, readMatch[1]);
      }
      const delMatch = pathname.match(/^\/admin\/api\/messages\/([^/]+)$/);
      if (delMatch && request.method === "DELETE") {
        return await handleDeleteMessage(request, env, delMatch[1]);
      }
      if (pathname === "/admin/api/publish" && request.method === "POST") {
        return await handlePublish(request, env);
      }
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }

    // qualquer outra rota: serve os arquivos estáticos do site
    return env.ASSETS.fetch(request);
  },
};
