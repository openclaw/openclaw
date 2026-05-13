import { patchSessionEntry } from "../config/sessions.js";

export async function reconcileSessionRowCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { sessionKey, agentId, observedCompactionCount, now = Date.now() } = params;
  if (!sessionKey || observedCompactionCount <= 0) {
    return undefined;
  }
  const nextEntry = await patchSessionEntry({
    agentId: agentId ?? "main",
    sessionKey,
    update: async (entry) => {
      const currentCount = Math.max(0, entry.compactionCount ?? 0);
      const nextCount = Math.max(currentCount, observedCompactionCount);
      if (nextCount === currentCount) {
        return null;
      }
      return {
        compactionCount: nextCount,
        updatedAt: Math.max(entry.updatedAt ?? 0, now),
      };
    },
  });
  return nextEntry?.compactionCount;
}
