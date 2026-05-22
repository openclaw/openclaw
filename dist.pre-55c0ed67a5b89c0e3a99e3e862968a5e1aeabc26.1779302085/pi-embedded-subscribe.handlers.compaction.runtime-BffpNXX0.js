import { u as resolveStorePath } from "./paths-DE6QEn2i.js";
import { c as updateSessionStoreEntry } from "./store-r4WEtwxi.js";
import "./sessions-Cq6eeDnZ.js";
import { t as log } from "./logger-JwYbMk1I.js";
//#region src/agents/pi-embedded-subscribe.handlers.compaction.runtime.ts
async function reconcileSessionStoreCompactionCountAfterSuccess(params) {
	const { sessionKey, agentId, configStore, observedCompactionCount, now = Date.now(), attribution } = params;
	if (!sessionKey || observedCompactionCount <= 0) return;
	const storePath = resolveStorePath(configStore, { agentId });
	let previousCompactionCount;
	let nextCompactionCount;
	const nextEntry = await updateSessionStoreEntry({
		storePath,
		sessionKey,
		update: async (entry) => {
			const currentCount = Math.max(0, entry.compactionCount ?? 0);
			const nextCount = Math.max(currentCount, observedCompactionCount);
			previousCompactionCount = currentCount;
			nextCompactionCount = nextCount;
			if (nextCount === currentCount) return null;
			return {
				compactionCount: nextCount,
				updatedAt: Math.max(entry.updatedAt ?? 0, now)
			};
		}
	});
	if (attribution && previousCompactionCount !== void 0 && nextCompactionCount !== void 0) {
		const delta = nextCompactionCount - previousCompactionCount;
		log[delta > 0 ? "info" : "debug"](`[compaction-counter] session=${sessionKey} runId=${attribution.runId ?? "unknown"} trigger=${attribution.trigger} outcome=${attribution.outcome} storeCount.before=${previousCompactionCount} storeCount.after=${nextCompactionCount} storeCount.delta=${delta}`);
	}
	return nextEntry?.compactionCount;
}
//#endregion
export { reconcileSessionStoreCompactionCountAfterSuccess };
