/**
 * Runtime helpers for reconciling compaction counts after subscribe events.
 */
import { resolveStorePath } from "../config/sessions/paths.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";

/**
 * Persist the highest observed compaction count after a successful subscribed run.
 *
 * NOTE: exported as a NAMED export (in addition to the default below). Consumers
 * reach this module through a dynamically-imported chunk; the bundler re-exports
 * that chunk with `export *`, which per the ES module spec does NOT forward a
 * `default` export. Importing the default therefore yielded `undefined` at runtime
 * ("TypeError: reconcile is not a function"), silently breaking compaction-count
 * reconciliation. A named export is forwarded by `export *`, so callers must import
 * the named symbol. The default is kept for backward compatibility (tests, etc.).
 */
export async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { sessionKey, agentId, configStore, observedCompactionCount, now = Date.now() } = params;
  if (!sessionKey || observedCompactionCount <= 0) {
    return undefined;
  }
  const storePath = resolveStorePath(configStore, { agentId });
  const nextEntry = await updateSessionEntry({ sessionKey, storePath }, async (entry) => {
    // The live stream and store can both observe compactions. Keep the max so
    // late lower-count updates cannot make future resume labels regress.
    const currentCount = Math.max(0, entry.compactionCount ?? 0);
    const nextCount = Math.max(currentCount, observedCompactionCount);
    if (nextCount === currentCount) {
      return null;
    }
    return {
      compactionCount: nextCount,
      updatedAt: Math.max(entry.updatedAt ?? 0, now),
    };
  });
  return nextEntry?.compactionCount;
}

export default reconcileSessionStoreCompactionCountAfterSuccess;
