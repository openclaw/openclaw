import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import { getMatrixRuntime } from "../runtime.js";

export type MatrixStoredCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
};

function credentialsFilename(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  if (normalized === DEFAULT_ACCOUNT_ID) {
    return "credentials.json";
  }
  // normalizeAccountId produces lowercase [a-z0-9-] strings, already filesystem-safe.
  // Different raw IDs that normalize to the same value are the same logical account.
  return `credentials-${normalized}.json`;
}

export function resolveMatrixCredentialsDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir?: string,
): string {
  const resolvedStateDir = stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(resolvedStateDir, "credentials", "matrix");
}

export function resolveMatrixCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): string {
  const dir = resolveMatrixCredentialsDir(env);
  return path.join(dir, credentialsFilename(accountId));
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    if (!fs.existsSync(credPath)) {
      return null;
    }
    const raw = fs.readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MatrixStoredCredentials>;
    if (
      typeof parsed.homeserver !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.accessToken !== "string"
    ) {
      return null;
    }
    return parsed as MatrixStoredCredentials;
  } catch {
    return null;
  }
}

export function saveMatrixCredentials(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const dir = resolveMatrixCredentialsDir(env);
  fs.mkdirSync(dir, { recursive: true });

  const credPath = resolveMatrixCredentialsPath(env, accountId);

  const existing = loadMatrixCredentials(env, accountId);
  const now = new Date().toISOString();

  const toSave: MatrixStoredCredentials = {
    ...credentials,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  };

  fs.writeFileSync(credPath, JSON.stringify(toSave, null, 2), "utf-8");
}

export function touchMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const existing = loadMatrixCredentials(env, accountId);
  if (!existing) {
    return;
  }

  existing.lastUsedAt = new Date().toISOString();
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  fs.writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8");
}

export function clearMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    if (fs.existsSync(credPath)) {
      fs.unlinkSync(credPath);
    }
  } catch {
    // ignore
  }
}

export function credentialsMatchConfig(
  stored: MatrixStoredCredentials,
  config: { homeserver: string; userId: string },
): boolean {
  // If userId is empty (token-based auth), only match homeserver
  if (!config.userId) {
    return stored.homeserver === config.homeserver;
  }
  return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
