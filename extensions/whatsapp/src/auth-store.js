import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../../../src/cli/command-format.js";
import { resolveOAuthDir } from "../../../src/config/paths.js";
import { info, success } from "../../../src/globals.js";
import { getChildLogger } from "../../../src/logging.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { defaultRuntime } from "../../../src/runtime.js";
import { jidToE164, resolveUserPath } from "../../../src/utils.js";
function resolveDefaultWebAuthDir() {
  return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}
const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();
function resolveWebCredsPath(authDir) {
  return path.join(authDir, "creds.json");
}
function resolveWebCredsBackupPath(authDir) {
  return path.join(authDir, "creds.json.bak");
}
function hasWebCredsSync(authDir) {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(authDir));
    return stats.isFile() && stats.size > 1;
  } catch {
    return false;
  }
}
function readCredsJsonRaw(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) {
      return null;
    }
    return fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
function maybeRestoreCredsFromBackup(authDir) {
  const logger = getChildLogger({ module: "web-session" });
  try {
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      JSON.parse(raw);
      return;
    }
    const backupRaw = readCredsJsonRaw(backupPath);
    if (!backupRaw) {
      return;
    }
    JSON.parse(backupRaw);
    fsSync.copyFileSync(backupPath, credsPath);
    try {
      fsSync.chmodSync(credsPath, 384);
    } catch {
    }
    logger.warn({ credsPath }, "restored corrupted WhatsApp creds.json from backup");
  } catch {
  }
}
async function webAuthExists(authDir = resolveDefaultWebAuthDir()) {
  const resolvedAuthDir = resolveUserPath(authDir);
  maybeRestoreCredsFromBackup(resolvedAuthDir);
  const credsPath = resolveWebCredsPath(resolvedAuthDir);
  try {
    await fs.access(resolvedAuthDir);
  } catch {
    return false;
  }
  try {
    const stats = await fs.stat(credsPath);
    if (!stats.isFile() || stats.size <= 1) {
      return false;
    }
    const raw = await fs.readFile(credsPath, "utf-8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}
async function clearLegacyBaileysAuthState(authDir) {
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  const shouldDelete = (name) => {
    if (name === "oauth.json") {
      return false;
    }
    if (name === "creds.json" || name === "creds.json.bak") {
      return true;
    }
    if (!name.endsWith(".json")) {
      return false;
    }
    return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
  };
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      if (!shouldDelete(entry.name)) {
        return;
      }
      await fs.rm(path.join(authDir, entry.name), { force: true });
    })
  );
}
async function logoutWeb(params) {
  const runtime = params.runtime ?? defaultRuntime;
  const resolvedAuthDir = resolveUserPath(params.authDir ?? resolveDefaultWebAuthDir());
  const exists = await webAuthExists(resolvedAuthDir);
  if (!exists) {
    runtime.log(info("No WhatsApp Web session found; nothing to delete."));
    return false;
  }
  if (params.isLegacyAuthDir) {
    await clearLegacyBaileysAuthState(resolvedAuthDir);
  } else {
    await fs.rm(resolvedAuthDir, { recursive: true, force: true });
  }
  runtime.log(success("Cleared WhatsApp Web credentials."));
  return true;
}
function readWebSelfId(authDir = resolveDefaultWebAuthDir()) {
  try {
    const credsPath = resolveWebCredsPath(resolveUserPath(authDir));
    if (!fsSync.existsSync(credsPath)) {
      return { e164: null, jid: null };
    }
    const raw = fsSync.readFileSync(credsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const jid = parsed?.me?.id ?? null;
    const e164 = jid ? jidToE164(jid, { authDir }) : null;
    return { e164, jid };
  } catch {
    return { e164: null, jid: null };
  }
}
function getWebAuthAgeMs(authDir = resolveDefaultWebAuthDir()) {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(resolveUserPath(authDir)));
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}
function logWebSelfId(authDir = resolveDefaultWebAuthDir(), runtime = defaultRuntime, includeChannelPrefix = false) {
  const { e164, jid } = readWebSelfId(authDir);
  const details = e164 || jid ? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}` : "unknown";
  const prefix = includeChannelPrefix ? "Web Channel: " : "";
  runtime.log(info(`${prefix}${details}`));
}
async function pickWebChannel(pref, authDir = resolveDefaultWebAuthDir()) {
  const choice = pref === "auto" ? "web" : pref;
  const hasWeb = await webAuthExists(authDir);
  if (!hasWeb) {
    throw new Error(
      `No WhatsApp Web session found. Run \`${formatCliCommand("openclaw channels login --channel whatsapp --verbose")}\` to link.`
    );
  }
  return choice;
}
export {
  WA_WEB_AUTH_DIR,
  getWebAuthAgeMs,
  hasWebCredsSync,
  logWebSelfId,
  logoutWeb,
  maybeRestoreCredsFromBackup,
  pickWebChannel,
  readCredsJsonRaw,
  readWebSelfId,
  resolveDefaultWebAuthDir,
  resolveWebCredsBackupPath,
  resolveWebCredsPath,
  webAuthExists
};
