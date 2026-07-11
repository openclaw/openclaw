// Memory Wiki plugin module serializes vault mutation transactions.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

type ActiveVaultMutation = { active: boolean };

const activeVaultMutations = new AsyncLocalStorage<ReadonlyMap<string, ActiveVaultMutation>>();
const vaultMutationQueue = new KeyedAsyncQueue();

/**
 * Keep coordinated vault read-modify-write transactions isolated from concurrent work in this process.
 * Nested compile calls re-enter; different agent vaults remain parallel.
 */
export async function withMemoryWikiVaultMutation<T>(
  vaultPath: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(vaultPath);
  const active = activeVaultMutations.getStore();
  if (active?.get(key)?.active) {
    return await mutation();
  }

  const lease = { active: true };
  const nextActive = new Map(active ?? []);
  nextActive.set(key, lease);
  return await vaultMutationQueue.enqueue(key, async () => {
    try {
      return await activeVaultMutations.run(nextActive, mutation);
    } finally {
      // Detached children inherit this object. Mark it inactive when the
      // owner exits so later work queues instead of bypassing serialization.
      lease.active = false;
    }
  });
}
