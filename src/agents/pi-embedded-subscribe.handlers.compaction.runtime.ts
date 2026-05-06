import { resolveStorePath, updateSessionStoreEntry } from "../config/sessions.js";
import type { CompactionCounterAttribution } from "./compaction-attribution.js";
import { log } from "./pi-embedded-runner/logger.js";

export async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
  attribution?: CompactionCounterAttribution;
}): Promise<number | undefined> {
  const {
    sessionKey,
    agentId,
    configStore,
    observedCompactionCount,
    now = Date.now(),
    attribution,
  } = params;
  if (!sessionKey || observedCompactionCount <= 0) {
    return undefined;
  }
  const storePath = resolveStorePath(configStore, { agentId });
  let previousCompactionCount: number | undefined;
  let nextCompactionCount: number | undefined;
  const nextEntry = await updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async (entry) => {
      const currentCount = Math.max(0, entry.compactionCount ?? 0);
      const nextCount = Math.max(currentCount, observedCompactionCount);
      previousCompactionCount = currentCount;
      nextCompactionCount = nextCount;
      if (nextCount === currentCount) {
        return null;
      }
      return {
        compactionCount: nextCount,
        updatedAt: Math.max(entry.updatedAt ?? 0, now),
      };
    },
  });
  if (attribution && previousCompactionCount !== undefined && nextCompactionCount !== undefined) {
    const delta = nextCompactionCount - previousCompactionCount;
    const level = delta > 0 ? "info" : "debug";
    log[level](
      `[compaction-counter] session=${sessionKey} runId=${attribution.runId ?? "unknown"} ` +
        `trigger=${attribution.trigger} outcome=${attribution.outcome} ` +
        `storeCount.before=${previousCompactionCount} storeCount.after=${nextCompactionCount} ` +
        `storeCount.delta=${delta}`,
    );
  }
  return nextEntry?.compactionCount;
}
