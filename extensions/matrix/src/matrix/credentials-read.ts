// Matrix plugin module implements credentials read behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMatrixRuntime } from "../runtime.js";

export { resolveMatrixCredentialsDir, resolveMatrixCredentialsPath } from "../storage-paths.js";

export type MatrixStoredCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
};

export type MatrixStoredCredentialRecord = MatrixStoredCredentials & {
  accountId: string;
};

export const MATRIX_CREDENTIALS_NAMESPACE = "credentials";
export const MATRIX_CREDENTIALS_MAX_ENTRIES = 256;

export function matrixCredentialsStoreKey(accountId?: string | null): string {
  return `account:${normalizeAccountId(accountId)}`;
}

export function normalizeMatrixStoredCredentials(
  value: unknown,
  accountId?: string | null,
): MatrixStoredCredentialRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const parsed = value as Partial<MatrixStoredCredentialRecord>;
  if (
    typeof parsed.homeserver !== "string" ||
    !parsed.homeserver ||
    typeof parsed.userId !== "string" ||
    !parsed.userId ||
    typeof parsed.accessToken !== "string" ||
    !parsed.accessToken ||
    typeof parsed.createdAt !== "string" ||
    !parsed.createdAt
  ) {
    return null;
  }
  const normalizedAccountId = normalizeAccountId(accountId ?? parsed.accountId);
  return {
    accountId: normalizedAccountId,
    homeserver: parsed.homeserver,
    userId: parsed.userId,
    accessToken: parsed.accessToken,
    ...(typeof parsed.deviceId === "string" ? { deviceId: parsed.deviceId } : {}),
    createdAt: parsed.createdAt,
    ...(typeof parsed.lastUsedAt === "string" ? { lastUsedAt: parsed.lastUsedAt } : {}),
  };
}

export function openMatrixCredentialsStore(
  env: NodeJS.ProcessEnv = process.env,
): PluginStateSyncKeyedStore<MatrixStoredCredentialRecord> {
  return getMatrixRuntime().state.openSyncKeyedStore<MatrixStoredCredentialRecord>({
    namespace: MATRIX_CREDENTIALS_NAMESPACE,
    maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env,
  });
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const normalizedAccountId = normalizeAccountId(accountId);
  const stored = openMatrixCredentialsStore(env).lookup(matrixCredentialsStoreKey(accountId));
  const parsed = normalizeMatrixStoredCredentials(stored, normalizedAccountId);
  if (!parsed || parsed.accountId !== normalizedAccountId) {
    return null;
  }
  const { accountId: _accountId, ...credentials } = parsed;
  return credentials;
}

export function clearMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  openMatrixCredentialsStore(env).delete(matrixCredentialsStoreKey(accountId));
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
