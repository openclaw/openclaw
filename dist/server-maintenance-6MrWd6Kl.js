import { f as sweepStaleRunContexts } from "./agent-events-CXxjiM_O.js";
import { r as cleanOldMedia } from "./store-b792nN7l.js";
import { r as HEALTH_REFRESH_INTERVAL_MS, s as TICK_INTERVAL_MS, t as DEDUPE_MAX } from "./server-constants-1JM0IS0k.js";
import { t as abortChatRunById } from "./chat-abort-BJLHIlT_.js";
import { n as pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit-BggFg1sK.js";
import { t as formatError } from "./server-utils-DYBz64u-.js";
import { s as setBroadcastHealthUpdate } from "./health-state-D-GXgVp4.js";
//#region src/gateway/server-maintenance.ts
function startGatewayMaintenanceTimers(params) {
	setBroadcastHealthUpdate((snap) => {
		params.broadcast("health", snap, { stateVersion: {
			presence: params.getPresenceVersion(),
			health: params.getHealthVersion()
		} });
		params.nodeSendToAllSubscribed("health", snap);
	});
	const tickInterval = setInterval(() => {
		const payload = { ts: Date.now() };
		params.broadcast("tick", payload);
		params.nodeSendToAllSubscribed("tick", payload);
	}, TICK_INTERVAL_MS);
	const healthInterval = setInterval(() => {
		params.refreshGatewayHealthSnapshot({ probe: true }).catch((err) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
	}, HEALTH_REFRESH_INTERVAL_MS);
	params.refreshGatewayHealthSnapshot({ probe: true }).catch((err) => params.logHealth.error(`initial refresh failed: ${formatError(err)}`));
	const dedupeCleanup = setInterval(() => {
		const AGENT_RUN_SEQ_MAX = 1e4;
		const now = Date.now();
		const isActiveRunDedupeKey = (key) => {
			if (!key.startsWith("agent:") && !key.startsWith("chat:")) return false;
			const runId = key.slice(key.indexOf(":") + 1);
			const entry = runId ? params.chatAbortControllers.get(runId) : void 0;
			if (!entry) return false;
			return key.startsWith("agent:") ? entry.kind === "agent" : entry.kind !== "agent";
		};
		for (const [k, v] of params.dedupe) {
			if (isActiveRunDedupeKey(k)) continue;
			if (now - v.ts > 3e5) params.dedupe.delete(k);
		}
		if (params.dedupe.size > 1e3) {
			const excess = params.dedupe.size - DEDUPE_MAX;
			const oldestKeys = [...params.dedupe.entries()].filter(([key]) => !isActiveRunDedupeKey(key)).toSorted(([, left], [, right]) => left.ts - right.ts).slice(0, excess).map(([key]) => key);
			for (const key of oldestKeys) params.dedupe.delete(key);
		}
		if (params.agentRunSeq.size > AGENT_RUN_SEQ_MAX) {
			const excess = params.agentRunSeq.size - AGENT_RUN_SEQ_MAX;
			let removed = 0;
			for (const runId of params.agentRunSeq.keys()) {
				params.agentRunSeq.delete(runId);
				removed += 1;
				if (removed >= excess) break;
			}
		}
		for (const [runId, entry] of params.chatAbortControllers) {
			if (now <= entry.expiresAtMs) continue;
			abortChatRunById({
				chatAbortControllers: params.chatAbortControllers,
				chatRunBuffers: params.chatRunBuffers,
				chatDeltaSentAt: params.chatDeltaSentAt,
				chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
				chatDeltaLastBroadcastText: params.chatRunState.deltaLastBroadcastText,
				chatAbortedRuns: params.chatRunState.abortedRuns,
				removeChatRun: params.removeChatRun,
				agentRunSeq: params.agentRunSeq,
				broadcast: params.broadcast,
				nodeSendToSession: params.nodeSendToSession
			}, {
				runId,
				sessionKey: entry.sessionKey,
				stopReason: "timeout"
			});
		}
		const ABORTED_RUN_TTL_MS = 60 * 6e4;
		for (const [runId, abortedAt] of params.chatRunState.abortedRuns) {
			if (now - abortedAt <= ABORTED_RUN_TTL_MS) continue;
			params.chatRunState.abortedRuns.delete(runId);
			params.chatRunBuffers.delete(runId);
			params.chatDeltaSentAt.delete(runId);
			params.chatDeltaLastBroadcastLen.delete(runId);
			params.chatRunState.deltaLastBroadcastText.delete(runId);
		}
		pruneStaleControlPlaneBuckets(now);
		for (const [runId, lastSentAt] of params.chatDeltaSentAt) {
			if (params.chatRunState.abortedRuns.has(runId)) continue;
			if (params.chatAbortControllers.has(runId)) continue;
			if (now - lastSentAt <= ABORTED_RUN_TTL_MS) continue;
			params.chatRunBuffers.delete(runId);
			params.chatDeltaSentAt.delete(runId);
			params.chatDeltaLastBroadcastLen.delete(runId);
			params.chatRunState.deltaLastBroadcastText.delete(runId);
		}
		sweepStaleRunContexts();
	}, 6e4);
	if (typeof params.mediaCleanupTtlMs !== "number") return {
		tickInterval,
		healthInterval,
		dedupeCleanup,
		mediaCleanup: null
	};
	let mediaCleanupInFlight = null;
	const runMediaCleanup = () => {
		if (mediaCleanupInFlight) return mediaCleanupInFlight;
		mediaCleanupInFlight = cleanOldMedia(params.mediaCleanupTtlMs, {
			recursive: true,
			pruneEmptyDirs: true
		}).catch((err) => {
			params.logHealth.error(`media cleanup failed: ${formatError(err)}`);
		}).finally(() => {
			mediaCleanupInFlight = null;
		});
		return mediaCleanupInFlight;
	};
	const mediaCleanup = setInterval(() => {
		runMediaCleanup();
	}, 60 * 6e4);
	runMediaCleanup();
	return {
		tickInterval,
		healthInterval,
		dedupeCleanup,
		mediaCleanup
	};
}
//#endregion
export { startGatewayMaintenanceTimers };
