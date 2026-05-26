import { resolveStorePath, updateSessionStoreEntry } from "../config/sessions.js";

export async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { sessionKey, agentId, configStore, observedCompactionCount } = params;
  if (!sessionKey || observedCompactionCount <= 0) {
    return undefined;
  }
  const storePath = resolveStorePath(configStore, { agentId });
  const nextEntry = await updateSessionStoreEntry({
    storePath,
    sessionKey,
    preserveActivity: true,
    update: async (entry) => {
      const currentCount = Math.max(0, entry.compactionCount ?? 0);
      const nextCount = Math.max(currentCount, observedCompactionCount);
      if (nextCount === currentCount) {
        return null;
      }
      return {
        compactionCount: nextCount,
      };
    },
  });
  return nextEntry?.compactionCount;
}
