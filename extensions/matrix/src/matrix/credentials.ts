// Matrix plugin module implements credentials behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { openMatrixCredentialsAsyncStore, openMatrixCredentialsStore } from "./credentials-read.js";
import {
  isMatrixCredentialRevocation,
  matrixCredentialsStoreKey,
  normalizeMatrixStoredCredentials,
} from "./credentials-state.js";
import type {
  MatrixCredentialStateRecord,
  MatrixStoredCredentialRecord,
  MatrixStoredCredentials,
} from "./credentials-state.js";

export {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
} from "./credentials-read.js";
export type { MatrixStoredCredentials } from "./credentials-state.js";

export async function saveMatrixCredentials(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const normalizedAccountId = normalizeAccountId(accountId);
  const preparedCredentials = { ...credentials };
  const now = new Date().toISOString();
  await updateMatrixCredentials(env, normalizedAccountId, (current) => {
    const existing = normalizeMatrixStoredCredentials(current, normalizedAccountId);
    return {
      accountId: normalizedAccountId,
      homeserver: preparedCredentials.homeserver,
      userId: preparedCredentials.userId,
      accessToken: preparedCredentials.accessToken,
      ...(typeof preparedCredentials.deviceId === "string"
        ? { deviceId: preparedCredentials.deviceId }
        : {}),
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    } satisfies MatrixStoredCredentialRecord;
  });
}

export async function saveBackfilledMatrixDeviceId(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<"saved" | "skipped"> {
  const normalizedAccountId = normalizeAccountId(accountId);
  const preparedCredentials = { ...credentials };
  const now = new Date().toISOString();
  let result: "saved" | "skipped" = "saved";
  await updateMatrixCredentials(env, normalizedAccountId, (current) => {
    result = "saved";
    // A delayed login backfill must not resurrect credentials after logout.
    if (isMatrixCredentialRevocation(current, normalizedAccountId)) {
      result = "skipped";
      return current;
    }
    const existing = normalizeMatrixStoredCredentials(current, normalizedAccountId);
    if (
      existing &&
      (existing.homeserver !== preparedCredentials.homeserver ||
        existing.userId !== preparedCredentials.userId ||
        existing.accessToken !== preparedCredentials.accessToken)
    ) {
      result = "skipped";
      return existing;
    }
    return {
      accountId: normalizedAccountId,
      homeserver: preparedCredentials.homeserver,
      userId: preparedCredentials.userId,
      accessToken: preparedCredentials.accessToken,
      ...(typeof preparedCredentials.deviceId === "string"
        ? { deviceId: preparedCredentials.deviceId }
        : {}),
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    } satisfies MatrixStoredCredentialRecord;
  });
  return result;
}

export async function touchMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const normalizedAccountId = normalizeAccountId(accountId);
  await updateMatrixCredentials(env, normalizedAccountId, (current) => {
    // A delayed activity touch must preserve an explicit logout tombstone.
    if (isMatrixCredentialRevocation(current, normalizedAccountId)) {
      return current;
    }
    const existing = normalizeMatrixStoredCredentials(current, normalizedAccountId);
    return existing ? { ...existing, lastUsedAt: new Date().toISOString() } : undefined;
  });
}

async function updateMatrixCredentials(
  env: NodeJS.ProcessEnv,
  accountId: string,
  update: (
    current: MatrixCredentialStateRecord | undefined,
  ) => MatrixCredentialStateRecord | undefined,
): Promise<void> {
  const store = openMatrixCredentialsAsyncStore(env);
  const key = matrixCredentialsStoreKey(accountId);
  if (!store.observe || !store.compareAndApply) {
    // Matrix's published >=2026.9.4 host floor predates data-only comparisons.
    openMatrixCredentialsStore(env).update(key, update);
    return;
  }
  let observation = await store.observe(key);
  for (;;) {
    const value = update(observation.value);
    const result = await store.compareAndApply(
      key,
      observation.comparison,
      value === undefined
        ? { operation: "update", action: "keep" }
        : { operation: "update", action: "set", value },
    );
    if (result.status !== "conflict") {
      return;
    }
    observation = result.current;
  }
}
