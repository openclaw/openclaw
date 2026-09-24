// Matrix plugin module implements credentials read behavior. Pure record
// shapes/normalizers live in credentials-state.ts; this module owns the
// plugin-state store access.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { getOptionalMatrixRuntime } from "../runtime.js";
import {
  MATRIX_CREDENTIALS_MAX_ENTRIES,
  MATRIX_CREDENTIALS_NAMESPACE,
  matrixCredentialsStoreKey,
  normalizeMatrixStoredCredentials,
  type MatrixCredentialStateRecord,
  type MatrixStoredCredentials,
} from "./credentials-state.js";

export { resolveMatrixCredentialsDir, resolveMatrixCredentialsPath } from "../storage-paths.js";

function matrixCredentialsStoreOptions(env: NodeJS.ProcessEnv) {
  const runtime = getOptionalMatrixRuntime();
  const resolvedEnv =
    env.OPENCLAW_STATE_DIR?.trim() || !runtime
      ? env
      : { ...env, OPENCLAW_STATE_DIR: runtime.state.resolveStateDir(env) };
  return {
    namespace: MATRIX_CREDENTIALS_NAMESPACE,
    maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
    overflowPolicy: "reject-new" as const,
    env: resolvedEnv,
  };
}

export function openMatrixCredentialsStore(env: NodeJS.ProcessEnv = process.env) {
  return createPluginStateSyncKeyedStore<MatrixCredentialStateRecord>(
    "matrix",
    matrixCredentialsStoreOptions(env),
  );
}

export function openMatrixCredentialsAsyncStore(env: NodeJS.ProcessEnv = process.env) {
  const options = matrixCredentialsStoreOptions(env);
  const runtime = getOptionalMatrixRuntime();
  return runtime
    ? runtime.state.openKeyedStore<MatrixCredentialStateRecord>(options)
    : createPluginStateKeyedStore<MatrixCredentialStateRecord>("matrix", options);
}

export function captureMatrixCredentialsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Resolve selectors before awaiting reads; spreading Windows process.env loses its lookup semantics.
  return {
    ...env,
    OPENCLAW_STATE_DIR:
      getOptionalMatrixRuntime()?.state.resolveStateDir(env) ?? resolveStateDir(env),
    OPENCLAW_SUPERVISOR_MODE: env.OPENCLAW_SUPERVISOR_MODE,
  };
}

export async function loadMatrixCredentialsAsync(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<MatrixStoredCredentials | null> {
  const stored = await openMatrixCredentialsAsyncStore(env).lookup(
    matrixCredentialsStoreKey(accountId),
  );
  return decodeMatrixCredentials(stored, accountId);
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const stored = openMatrixCredentialsStore(env).lookup(matrixCredentialsStoreKey(accountId));
  return decodeMatrixCredentials(stored, accountId);
}

function decodeMatrixCredentials(
  stored: MatrixCredentialStateRecord | undefined,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const normalizedAccountId = normalizeAccountId(accountId);
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
  const normalizedAccountId = normalizeAccountId(accountId);
  // Keep a durable revocation marker so doctor cannot resurrect explicitly
  // cleared credentials from a legacy file left by an interrupted migration.
  openMatrixCredentialsStore(env).register(matrixCredentialsStoreKey(normalizedAccountId), {
    accountId: normalizedAccountId,
    kind: "revoked",
    revokedAt: new Date().toISOString(),
  });
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
