#!/usr/bin/env node
/* Generic %notes client for OpenClaw/Tlon agents.
   Default write commands are dry-run; pass --apply to mutate live %notes. */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

function usage(exitCode = 0) {
  const text = `Usage:
  notes-client.js [auth opts] list-notebooks
  notes-client.js [auth opts] list-folders <notebook-ref>
  notes-client.js [auth opts] list-notes <notebook-ref>
  notes-client.js [auth opts] create-notebook <title> [--apply]
  notes-client.js [auth opts] create-folder <notebook-ref> <parent-folder-id> <name> [--apply]
  notes-client.js [auth opts] create-note <notebook-ref> <folder-id> <title> <body-file|-> [--apply]
  notes-client.js [auth opts] update-note <notebook-ref> <note-id> <expected-revision> <body-file|-> [--apply]
  notes-client.js [auth opts] move-note <notebook-ref> <note-id> <folder-id> [--apply]
  notes-client.js [auth opts] batch-import <notebook-ref> <folder-id> <notes-json-file> [--apply]

Auth opts:
  --url https://ship.tlon.network       or URBIT_URL / SHIP_URL
  --ship ~ship                          or URBIT_SHIP / SHIP_NAME / cached ship
  --cookie 'urbauth-~ship=...'          or URBIT_COOKIE / SHIP_COOKIE
  --code sampel-ticlyt-migfun-falmel    or URBIT_CODE / SHIP_CODE

Notebook refs may be an id, title, flag name, or full v0 flag like ~host/wiki-5.
Writes are dry-run unless --apply is present. Output is JSON.`;
  console.log(text);
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) usage(0);

function takeFlag(names) {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i !== -1) {
      const value = argv[i + 1];
      argv.splice(i, 2);
      return value;
    }
    const pref = `${name}=`;
    const j = argv.findIndex((a) => a.startsWith(pref));
    if (j !== -1) {
      const value = argv[j].slice(pref.length);
      argv.splice(j, 1);
      return value;
    }
  }
  return null;
}

const APPLY = argv.includes("--apply");
if (APPLY) argv.splice(argv.indexOf("--apply"), 1);
const URL_OPT = takeFlag(["--url"]);
const SHIP_OPT = takeFlag(["--ship"]);
const COOKIE_OPT = takeFlag(["--cookie"]);
const CODE_OPT = takeFlag(["--code"]);

function bareShip(ship) {
  return String(ship || "")
    .trim()
    .replace(/^~/, "");
}
function sigShip(ship) {
  const bare = bareShip(ship);
  return bare ? `~${bare}` : "";
}

function loadCache(ship) {
  const candidates = [];
  const cacheDir = path.join(os.homedir(), ".tlon", "cache");
  if (ship) candidates.push(path.join(cacheDir, `${bareShip(ship)}.json`));
  try {
    for (const file of fs.readdirSync(cacheDir)) {
      if (file.endsWith(".json")) candidates.push(path.join(cacheDir, file));
    }
  } catch {}
  for (const file of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!ship || bareShip(parsed.ship || file.replace(/\.json$/, "")) === bareShip(ship))
        return parsed;
    } catch {}
  }
  return null;
}

function shipFromCookie(cookie) {
  const m = String(cookie || "").match(/urbauth-(~[a-z-]+)=/);
  return m ? m[1] : null;
}

function request({ method = "GET", url, cookie, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const payload = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = mod.request(
      u,
      {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: data, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(shipUrl, ship, code) {
  const res = await request({
    method: "POST",
    url: new URL("/~/login", shipUrl).toString(),
    body: `password=${encodeURIComponent(code)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const cookies = res.headers["set-cookie"] || [];
  const want = sigShip(ship);
  for (const c of cookies) {
    const m = c.match(/(urbauth-~[^=]+=[^;]+)/);
    if (m && (!want || m[1].startsWith(`urbauth-${want}=`))) return m[1];
  }
  throw new Error(`login failed; no urbauth cookie in HTTP ${res.status}`);
}

async function makeAuth() {
  const env = process.env;
  let ship = SHIP_OPT || env.URBIT_SHIP || env.SHIP_NAME || null;
  let cache = loadCache(ship);
  let shipUrl = URL_OPT || env.URBIT_URL || env.SHIP_URL || cache?.url;
  let cookie = COOKIE_OPT || env.URBIT_COOKIE || env.SHIP_COOKIE || env.URBIT_AUTH || cache?.cookie;
  const code = CODE_OPT || env.URBIT_CODE || env.SHIP_CODE || cache?.code;
  if (!ship && cookie) ship = shipFromCookie(cookie);
  if (!ship && cache?.ship) ship = cache.ship;
  if (!shipUrl)
    throw new Error(
      "missing ship URL; pass --url or set URBIT_URL/SHIP_URL or cache ~/.tlon/cache/<ship>.json",
    );
  if (!cookie) {
    if (!code) throw new Error("missing auth; pass --cookie or --code, set env, or use tlon cache");
    cookie = await login(shipUrl, ship, code);
  }
  if (!ship) ship = shipFromCookie(cookie);
  if (!ship) throw new Error("missing ship; pass --ship or use a urbauth cookie containing ship");
  return { shipUrl, ship: sigShip(ship), shipBare: bareShip(ship), cookie };
}

async function shipScry(auth, scryPath) {
  const res = await request({
    url: new URL(`/~/scry${scryPath}`, auth.shipUrl).toString(),
    cookie: auth.cookie,
  });
  if (res.status < 200 || res.status >= 300) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

async function shipPoke(auth, jsonActions, channelPrefix = "notes-client") {
  const ts = Date.now();
  const body = jsonActions.map((json, i) => ({
    id: i + 1,
    action: "poke",
    ship: auth.shipBare,
    app: "notes",
    mark: "notes-action",
    json,
  }));
  const res = await request({
    method: "PUT",
    url: new URL(`/~/channel/${channelPrefix}-${ts}`, auth.shipUrl).toString(),
    cookie: auth.cookie,
    body,
  });
  if (res.status !== 204)
    throw new Error(`poke failed HTTP ${res.status}: ${res.body.slice(0, 500)}`);
  return { status: res.status };
}

function normalizeFlag(host, name) {
  if (!host || !name) return null;
  return `${sigShip(host)}/${String(name).replace(/^\//, "")}`;
}

function normalizeNotebookEntry(entry, apiVersion = null) {
  if (!entry || typeof entry !== "object") return null;
  const notebook = entry.notebook && typeof entry.notebook === "object" ? entry.notebook : entry;
  const flag =
    entry.flag || normalizeFlag(entry.host, entry.flagName || entry.flag_name || entry.name);
  const id = Number(notebook.id ?? entry.id);
  const title = String(notebook.title ?? entry.title ?? "").trim();
  if (!Number.isFinite(id) || !title) return null;
  return {
    apiVersion: apiVersion || (flag ? "v0" : "legacy"),
    id,
    title,
    host: entry.host || (flag ? flag.split("/")[0] : null),
    flagName: entry.flagName || entry.flag_name || (flag ? flag.split("/")[1] : null),
    flag,
    visibility: entry.visibility || null,
  };
}

function notebookKey(nb) {
  return nb?.flag || String(nb?.id ?? "unknown");
}
function notebookMatches(nb, ref) {
  const raw = String(ref || "").trim();
  if (!raw) return false;
  const low = raw.toLowerCase();
  if (nb.flag && nb.flag.toLowerCase() === low) return true;
  if (nb.flagName && nb.flagName.toLowerCase() === low.replace(/^.*\//, "")) return true;
  if (nb.title && nb.title.toLowerCase() === low) return true;
  if (/^\d+$/.test(raw) && Number(raw) === nb.id) return true;
  return false;
}

async function listNotebooks(auth) {
  const v0 = await shipScry(auth, "/notes/v0/notebooks.json");
  if (Array.isArray(v0))
    return {
      apiVersion: "v0",
      notebooks: v0.map((x) => normalizeNotebookEntry(x, "v0")).filter(Boolean),
    };
  const legacy = await shipScry(auth, "/notes/notebooks.json");
  if (Array.isArray(legacy))
    return {
      apiVersion: "legacy",
      notebooks: legacy.map((x) => normalizeNotebookEntry(x, "legacy")).filter(Boolean),
    };
  throw new Error("failed to read %notes notebooks via v0 or legacy scries");
}

async function resolveNotebook(auth, ref) {
  const { notebooks } = await listNotebooks(auth);
  const found = notebooks.find((nb) => notebookMatches(nb, ref));
  if (!found)
    throw new Error(
      `notebook not found: ${ref}; visible: ${notebooks.map(notebookKey).join(", ") || "none"}`,
    );
  return found;
}

async function getFolders(auth, nb) {
  const p =
    nb.apiVersion === "v0" || nb.flag
      ? `/notes/v0/folders/${nb.flag}.json`
      : `/notes/folders/${nb.id}.json`;
  return (await shipScry(auth, p)) || [];
}
async function getNotes(auth, nb) {
  const p =
    nb.apiVersion === "v0" || nb.flag
      ? `/notes/v0/notes/${nb.flag}.json`
      : `/notes/notes/${nb.id}.json`;
  return (await shipScry(auth, p)) || [];
}

function notebookAction(nb, action) {
  if (nb.apiVersion === "v0" || nb.flag) return { type: "notebook", flag: nb.flag, action };
  return null;
}
function actionCreateNotebook(title, apiVersion = "v0") {
  return apiVersion === "v0" ? { type: "create-notebook", title } : { "create-notebook": title };
}
function actionCreateFolder(nb, parent, name) {
  return (
    notebookAction(nb, { type: "create-folder", parent: Number(parent), name }) || {
      "create-folder": { notebookId: nb.id, parentFolderId: Number(parent), name },
    }
  );
}
function actionCreateNote(nb, folder, title, body) {
  return (
    notebookAction(nb, { type: "create-note", folder: Number(folder), title, body }) || {
      "create-note": { notebookId: nb.id, folderId: Number(folder), title, bodyMd: body },
    }
  );
}
function actionUpdateNote(nb, noteId, expectedRevision, body) {
  return (
    notebookAction(nb, {
      type: "note",
      id: Number(noteId),
      action: { type: "update", body, expectedRevision: Number(expectedRevision) },
    }) || {
      "update-note": {
        noteId: Number(noteId),
        bodyMd: body,
        expectedRevision: Number(expectedRevision),
      },
    }
  );
}
function actionMoveNote(nb, noteId, folder) {
  return (
    notebookAction(nb, {
      type: "note",
      id: Number(noteId),
      action: { type: "move", folder: Number(folder) },
    }) || { "move-note": { noteId: Number(noteId), folderId: Number(folder) } }
  );
}
function actionBatchImport(nb, folder, notes) {
  return (
    notebookAction(nb, { type: "batch-import", folder: Number(folder), notes }) || {
      "batch-import": {
        notebookId: nb.id,
        folderId: Number(folder),
        notes: notes.map((n) => ({ title: n.title, bodyMd: n.body || n.bodyMd || "" })),
      },
    }
  );
}

function readBody(file) {
  return file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
}
function dryOrApply(auth, json, apply, label) {
  if (!apply) return Promise.resolve({ dryRun: true, label, json });
  return shipPoke(auth, Array.isArray(json) ? json : [json], label).then((r) => ({
    applied: true,
    label,
    ...r,
  }));
}

async function main() {
  const cmd = argv.shift();
  if (!cmd) usage(1);
  const auth = await makeAuth();
  let out;

  if (cmd === "list-notebooks") out = await listNotebooks(auth);
  else if (cmd === "list-folders") {
    const nb = await resolveNotebook(auth, argv[0]);
    out = { notebook: nb, folders: await getFolders(auth, nb) };
  } else if (cmd === "list-notes") {
    const nb = await resolveNotebook(auth, argv[0]);
    out = { notebook: nb, notes: await getNotes(auth, nb) };
  } else if (cmd === "create-notebook") {
    const { apiVersion } = await listNotebooks(auth).catch(() => ({ apiVersion: "v0" }));
    out = await dryOrApply(
      auth,
      actionCreateNotebook(argv.join(" "), apiVersion),
      APPLY,
      "notes-create-notebook",
    );
  } else if (cmd === "create-folder") {
    const [ref, parent, ...nameParts] = argv;
    const nb = await resolveNotebook(auth, ref);
    out = await dryOrApply(
      auth,
      actionCreateFolder(nb, parent, nameParts.join(" ")),
      APPLY,
      "notes-create-folder",
    );
  } else if (cmd === "create-note") {
    const [ref, folder, title, bodyFile] = argv;
    const nb = await resolveNotebook(auth, ref);
    out = await dryOrApply(
      auth,
      actionCreateNote(nb, folder, title, readBody(bodyFile)),
      APPLY,
      "notes-create-note",
    );
  } else if (cmd === "update-note") {
    const [ref, noteId, rev, bodyFile] = argv;
    const nb = await resolveNotebook(auth, ref);
    out = await dryOrApply(
      auth,
      actionUpdateNote(nb, noteId, rev, readBody(bodyFile)),
      APPLY,
      "notes-update-note",
    );
  } else if (cmd === "move-note") {
    const [ref, noteId, folder] = argv;
    const nb = await resolveNotebook(auth, ref);
    out = await dryOrApply(auth, actionMoveNote(nb, noteId, folder), APPLY, "notes-move-note");
  } else if (cmd === "batch-import") {
    const [ref, folder, file] = argv;
    const nb = await resolveNotebook(auth, ref);
    const notes = JSON.parse(fs.readFileSync(file, "utf8"));
    out = await dryOrApply(auth, actionBatchImport(nb, folder, notes), APPLY, "notes-batch-import");
  } else usage(1);

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }, null, 2));
  process.exit(1);
});
