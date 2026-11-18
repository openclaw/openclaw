import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
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
  const digest = sha256Hex(normalizedAccountId);
  return `${namespace}-${digest}`;
}

export function toPluginJsonValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

const sqliteMutationLocks = new KeyedAsyncQueue();

export async function withMSTeamsSqliteMutationLock<T>(
  mutationKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const scopedMutationKey = path.join(getMSTeamsRuntime().state.resolveStateDir(), mutationKey);
  // The Gateway owns plugin state; serialize local writers, not unsupported competing processes.
  return await sqliteMutationLocks.enqueue(scopedMutationKey, fn);
}
