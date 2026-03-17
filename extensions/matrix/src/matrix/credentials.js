import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getMatrixRuntime } from "../runtime.js";
function credentialsFilename(accountId) {
  const normalized = normalizeAccountId(accountId);
  if (normalized === DEFAULT_ACCOUNT_ID) {
    return "credentials.json";
  }
  return `credentials-${normalized}.json`;
}
function resolveMatrixCredentialsDir(env = process.env, stateDir) {
  const resolvedStateDir = stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(resolvedStateDir, "credentials", "matrix");
}
function resolveMatrixCredentialsPath(env = process.env, accountId) {
  const dir = resolveMatrixCredentialsDir(env);
  return path.join(dir, credentialsFilename(accountId));
}
function loadMatrixCredentials(env = process.env, accountId) {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    if (!fs.existsSync(credPath)) {
      return null;
    }
    const raw = fs.readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.homeserver !== "string" || typeof parsed.userId !== "string" || typeof parsed.accessToken !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function saveMatrixCredentials(credentials, env = process.env, accountId) {
  const dir = resolveMatrixCredentialsDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  const existing = loadMatrixCredentials(env, accountId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const toSave = {
    ...credentials,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now
  };
  fs.writeFileSync(credPath, JSON.stringify(toSave, null, 2), "utf-8");
}
function touchMatrixCredentials(env = process.env, accountId) {
  const existing = loadMatrixCredentials(env, accountId);
  if (!existing) {
    return;
  }
  existing.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  fs.writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8");
}
function clearMatrixCredentials(env = process.env, accountId) {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    if (fs.existsSync(credPath)) {
      fs.unlinkSync(credPath);
    }
  } catch {
  }
}
function credentialsMatchConfig(stored, config) {
  if (!config.userId) {
    return stored.homeserver === config.homeserver;
  }
  return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
export {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
  saveMatrixCredentials,
  touchMatrixCredentials
};
