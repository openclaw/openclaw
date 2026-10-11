import crypto from "node:crypto";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { getMSTeamsRuntime } from "./runtime.js";

export function resolveMSTeamsAccountStateNamespace(
  namespace: string,
  accountId?: string | null,
): string {
  const normalizedAccountId = normalizeAccountId(accountId);
  // Default namespaces are also used by Doctor's legacy-state migration.
  if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
    return namespace;
  }
  const digest = crypto.createHash("sha256").update(normalizedAccountId).digest("hex");
  return `${namespace}-${digest}`;
}

export function toPluginJsonValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

const sqliteMutationLocks = new KeyedAsyncQueue();
const MSTEAMS_MUTATION_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export async function withMSTeamsSqliteMutationLock<T>(
  mutationKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const scopedMutationKey = path.join(getMSTeamsRuntime().state.resolveStateDir(), mutationKey);
  return await sqliteMutationLocks.enqueue(scopedMutationKey, () =>
    withFileLock(scopedMutationKey, MSTEAMS_MUTATION_LOCK_OPTIONS, fn),
  );
}
