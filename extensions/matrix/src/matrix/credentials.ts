import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../account-selection.js";
import { writeJsonFileAtomically } from "../runtime-api.js";
import { getMatrixRuntime } from "../runtime.js";
import {
  resolveMatrixCredentialsDir as resolveSharedMatrixCredentialsDir,
  resolveMatrixCredentialsPath as resolveSharedMatrixCredentialsPath,
} from "../storage-paths.js";

export type MatrixStoredCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
};

function resolveStateDir(env: NodeJS.ProcessEnv): string {
  return getMatrixRuntime().state.resolveStateDir(env, os.homedir);
}

function resolveLegacyMatrixCredentialsPath(env: NodeJS.ProcessEnv): string | null {
  return path.join(resolveMatrixCredentialsDir(env), "credentials.json");
}

function shouldReadLegacyCredentialsForAccount(accountId?: string | null): boolean {
  const normalizedAccountId = normalizeAccountId(accountId);
  const cfg = getMatrixRuntime().config.loadConfig();
  if (!cfg.channels?.matrix || typeof cfg.channels.matrix !== "object") {
    return normalizedAccountId === DEFAULT_ACCOUNT_ID;
  }
  if (requiresExplicitMatrixDefaultAccount(cfg)) {
    return false;
  }
  return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg)) === normalizedAccountId;
}

function resolveLegacyMigrationSourcePath(
  env: NodeJS.ProcessEnv,
  accountId?: string | null,
): string | null {
  if (!shouldReadLegacyCredentialsForAccount(accountId)) {
    return null;
  }
  const legacyPath = resolveLegacyMatrixCredentialsPath(env);
  return legacyPath === resolveMatrixCredentialsPath(env, accountId) ? null : legacyPath;
}

function parseMatrixCredentialsFile(filePath: string): MatrixStoredCredentials | null {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<MatrixStoredCredentials>;
  if (
    typeof parsed.homeserver !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.accessToken !== "string"
  ) {
    return null;
  }
  return parsed as MatrixStoredCredentials;
}

export function resolveMatrixCredentialsDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir?: string,
): string {
  const resolvedStateDir = stateDir ?? resolveStateDir(env);
  return resolveSharedMatrixCredentialsDir(resolvedStateDir);
}

export function resolveMatrixCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): string {
  const resolvedStateDir = resolveStateDir(env);
  return resolveSharedMatrixCredentialsPath({ stateDir: resolvedStateDir, accountId });
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    if (fs.existsSync(credPath)) {
      return parseMatrixCredentialsFile(credPath);
    }

    const legacyPath = resolveLegacyMigrationSourcePath(env, accountId);
    if (!legacyPath || !fs.existsSync(legacyPath)) {
      return null;
    }

    const parsed = parseMatrixCredentialsFile(legacyPath);
    if (!parsed) {
      return null;
    }

    try {
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.renameSync(legacyPath, credPath);
    } catch {
      // Keep returning the legacy credentials even if migration fails.
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function saveMatrixCredentials(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const credPath = resolveMatrixCredentialsPath(env, accountId);

  const existing = loadMatrixCredentials(env, accountId);
  const now = new Date().toISOString();

  const toSave: MatrixStoredCredentials = {
    ...credentials,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  };

  await writeJsonFileAtomically(credPath, toSave);
}

export async function touchMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const existing = loadMatrixCredentials(env, accountId);
  if (!existing) {
    return;
  }

  existing.lastUsedAt = new Date().toISOString();
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  await writeJsonFileAtomically(credPath, existing);
}

export function clearMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const paths = [
    resolveMatrixCredentialsPath(env, accountId),
    resolveLegacyMigrationSourcePath(env, accountId),
  ];
  for (const filePath of paths) {
    if (!filePath) {
      continue;
    }
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }
}

export function credentialsMatchConfig(
  stored: MatrixStoredCredentials,
  config: { homeserver: string; userId: string; accessToken?: string },
): boolean {
  if (!config.userId) {
    if (!config.accessToken) {
      return false;
    }
    return stored.homeserver === config.homeserver && stored.accessToken === config.accessToken;
  }
  return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
