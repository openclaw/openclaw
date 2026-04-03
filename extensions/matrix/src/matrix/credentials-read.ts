import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../account-selection.js";
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
  try {
    return getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  } catch {
    // Some config-only helpers read stored credentials before the Matrix plugin
    // runtime is installed. Fall back to the standard state-dir env contract.
    const override = env.OPENCLAW_STATE_DIR?.trim();
    if (override) {
      return path.resolve(override);
    }
    const homeDir = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || os.homedir();
    return path.join(homeDir, ".openclaw");
  }
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

function loadCurrentMatrixCredentialsIfPresent(credPath: string): MatrixStoredCredentials | null {
  try {
    return fs.existsSync(credPath) ? parseMatrixCredentialsFile(credPath) : null;
  } catch {
    return null;
  }
}

function parseLegacyMatrixCredentialsWithRetry(params: {
  legacyPath: string;
  credPath: string;
}): MatrixStoredCredentials | null {
  try {
    return parseMatrixCredentialsFile(params.legacyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    return loadCurrentMatrixCredentialsIfPresent(params.credPath);
  }
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

    const parsed = parseLegacyMatrixCredentialsWithRetry({ legacyPath, credPath });
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
