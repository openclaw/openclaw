import { createAsyncLock, type AsyncLock } from "./async-lock.js";
import {
  loadMatrixCredentials,
  resolveMatrixCredentialsStateKey,
  saveMatrixCredentialsState,
} from "./credentials-read.js";
import type { MatrixStoredCredentials } from "./credentials-read.js";

export {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
} from "./credentials-read.js";
export type { MatrixStoredCredentials } from "./credentials-read.js";

const credentialWriteLocks = new Map<string, AsyncLock>();

function withCredentialWriteLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  let withLock = credentialWriteLocks.get(lockKey);
  if (!withLock) {
    withLock = createAsyncLock();
    credentialWriteLocks.set(lockKey, withLock);
  }
  return withLock(fn);
}

async function writeMatrixCredentialsUnlocked(params: {
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">;
  existing: MatrixStoredCredentials | null;
  env: NodeJS.ProcessEnv;
  accountId?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const toSave: MatrixStoredCredentials = {
    ...params.credentials,
    createdAt: params.existing?.createdAt ?? now,
    lastUsedAt: now,
  };
  saveMatrixCredentialsState(toSave, params.env, params.accountId);
}

export async function saveMatrixCredentials(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const lockKey = resolveMatrixCredentialsStateKey(accountId);
  await withCredentialWriteLock(lockKey, async () => {
    await writeMatrixCredentialsUnlocked({
      credentials,
      existing: loadMatrixCredentials(env, accountId),
      env,
      accountId,
    });
  });
}

export async function saveBackfilledMatrixDeviceId(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<"saved" | "skipped"> {
  const lockKey = resolveMatrixCredentialsStateKey(accountId);
  return await withCredentialWriteLock(lockKey, async () => {
    const existing = loadMatrixCredentials(env, accountId);
    if (
      existing &&
      (existing.homeserver !== credentials.homeserver ||
        existing.userId !== credentials.userId ||
        existing.accessToken !== credentials.accessToken)
    ) {
      return "skipped";
    }

    await writeMatrixCredentialsUnlocked({
      credentials,
      existing,
      env,
      accountId,
    });
    return "saved";
  });
}

export async function touchMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const lockKey = resolveMatrixCredentialsStateKey(accountId);
  await withCredentialWriteLock(lockKey, async () => {
    const existing = loadMatrixCredentials(env, accountId);
    if (!existing) {
      return;
    }

    existing.lastUsedAt = new Date().toISOString();
    saveMatrixCredentialsState(existing, env, accountId);
  });
}
