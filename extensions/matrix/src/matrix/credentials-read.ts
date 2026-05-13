import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
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

const MATRIX_CREDENTIALS_NAMESPACE = "credentials";
function createMatrixCredentialsStore(
  stateDir: string,
): PluginStateSyncKeyedStore<MatrixStoredCredentials> {
  return createPluginStateSyncKeyedStore<MatrixStoredCredentials>("matrix", {
    namespace: MATRIX_CREDENTIALS_NAMESPACE,
    maxEntries: 1_000,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

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

export function resolveMatrixCredentialsStateKey(accountId?: string | null): string {
  return normalizeAccountId(accountId) || DEFAULT_ACCOUNT_ID;
}

export function normalizeMatrixCredentials(value: unknown): MatrixStoredCredentials | null {
  const parsed =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<MatrixStoredCredentials>)
      : {};
  if (
    typeof parsed.homeserver !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.accessToken !== "string"
  ) {
    return null;
  }
  const credentials: MatrixStoredCredentials = {
    homeserver: parsed.homeserver,
    userId: parsed.userId,
    accessToken: parsed.accessToken,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
  };
  if (typeof parsed.deviceId === "string") {
    credentials.deviceId = parsed.deviceId;
  }
  if (typeof parsed.lastUsedAt === "string") {
    credentials.lastUsedAt = parsed.lastUsedAt;
  }
  return credentials;
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
  try {
    const stateDir = resolveStateDir(env);
    return normalizeMatrixCredentials(
      createMatrixCredentialsStore(stateDir).lookup(resolveMatrixCredentialsStateKey(accountId)),
    );
  } catch {
    return null;
  }
}

export function loadMatrixCredentialsFromStateEnv(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  try {
    const stateDir = resolveStateDir(env);
    return normalizeMatrixCredentials(
      createMatrixCredentialsStore(stateDir).lookup(resolveMatrixCredentialsStateKey(accountId)),
    );
  } catch {
    return null;
  }
}

export function saveMatrixCredentialsState(
  credentials: MatrixStoredCredentials,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const normalized = normalizeMatrixCredentials(credentials);
  if (!normalized) {
    return;
  }
  const stateDir = resolveStateDir(env);
  createMatrixCredentialsStore(stateDir).register(
    resolveMatrixCredentialsStateKey(accountId),
    normalized,
  );
}

export function clearMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  try {
    const stateDir = resolveStateDir(env);
    createMatrixCredentialsStore(stateDir).delete(resolveMatrixCredentialsStateKey(accountId));
  } catch {
    // ignore
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
