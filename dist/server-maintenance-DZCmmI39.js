import { f as sweepStaleRunContexts } from "./agent-events-BuYtWSh4.js";
import { r as cleanOldMedia } from "./store-rQFzzX5P.js";
import { t as abortChatRunById } from "./chat-abort-GHhFaqcz.js";
import { r as HEALTH_REFRESH_INTERVAL_MS, s as TICK_INTERVAL_MS, t as DEDUPE_MAX } from "./server-constants-BGwLM6XN.js";
import { n as pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit-AYt-ugaJ.js";
import { t as formatError } from "./server-utils-9y0vZuz2.js";
import { s as setBroadcastHealthUpdate } from "./health-state-DDBJpyWb.js";
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
		const resolveDedupeRunId = (key, entry) => {
			if (!key.startsWith("agent:") && !key.startsWith("chat:")) return;
			const keyRunId = key.slice(key.indexOf(":") + 1);
			if (keyRunId) {
				if (params.chatAbortControllers.get(keyRunId)) return keyRunId;
			}
			const payload = entry.payload;
			return payload && typeof payload === "object" && !Array.isArray(payload) ? typeof payload.runId === "string" ? payload.runId.trim() || void 0 : void 0 : void 0;
		};
		const isPendingAcceptedAgentDedupeKey = (key, dedupeEntry) => {
			if (!key.startsWith("agent:")) return false;
			const payload = dedupeEntry.payload;
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
			if (payload.status !== "accepted") return false;
			const expiresAtMs = payload.expiresAtMs;
			return typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) && expiresAtMs > now;
		};
		const isActiveRunDedupeKey = (key, dedupeEntry) => {
			if (!key.startsWith("agent:") && !key.startsWith("chat:")) return false;
			const runId = resolveDedupeRunId(key, dedupeEntry);
			const entry = runId ? params.chatAbortControllers.get(runId) : void 0;
			if (!entry) return false;
			return key.startsWith("agent:") ? entry.kind === "agent" : entry.kind !== "agent";
		};
		for (const [k, v] of params.dedupe) {
			if (isActiveRunDedupeKey(k, v) || isPendingAcceptedAgentDedupeKey(k, v)) continue;
			if (now - v.ts > 3e5) params.dedupe.delete(k);
		}
		if (params.dedupe.size > 1e3) {
			const excess = params.dedupe.size - DEDUPE_MAX;
			const oldestKeys = [...params.dedupe.entries()].filter(([key, entry]) => !isActiveRunDedupeKey(key, entry) && !isPendingAcceptedAgentDedupeKey(key, entry)).toSorted(([, left], [, right]) => left.ts - right.ts).slice(0, excess).map(([key]) => key);
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
		const clearAgentThrottleStateForRun = (runId) => {
			params.chatRunState.agentDeltaSentAt.delete(runId);
			params.chatRunState.agentDeltaSentAt.delete(`${runId}:assistant`);
			params.chatRunState.agentDeltaSentAt.delete(`${runId}:thinking`);
			params.chatRunState.bufferedAgentEvents.delete(runId);
			params.chatRunState.bufferedAgentEvents.delete(`${runId}:assistant`);
			params.chatRunState.bufferedAgentEvents.delete(`${runId}:thinking`);
		};
		const resolveAgentThrottleRunId = (key) => {
			if (key.endsWith(":assistant")) return key.slice(0, -10);
			if (key.endsWith(":thinking")) return key.slice(0, -9);
			return key;
		};
		for (const [runId, entry] of params.chatAbortControllers) {
			if (now <= entry.expiresAtMs) continue;
			abortChatRunById({
				chatAbortControllers: params.chatAbortControllers,
				chatRunBuffers: params.chatRunBuffers,
				chatDeltaSentAt: params.chatDeltaSentAt,
				chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
				chatDeltaLastBroadcastText: params.chatRunState.deltaLastBroadcastText,
				agentDeltaSentAt: params.chatRunState.agentDeltaSentAt,
				bufferedAgentEvents: params.chatRunState.bufferedAgentEvents,
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
			clearAgentThrottleStateForRun(runId);
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
			clearAgentThrottleStateForRun(runId);
		}
		for (const [key, lastSentAt] of params.chatRunState.agentDeltaSentAt) {
			const runId = resolveAgentThrottleRunId(key);
			if (params.chatRunState.abortedRuns.has(runId)) continue;
			if (params.chatAbortControllers.has(runId)) continue;
			if (now - lastSentAt <= ABORTED_RUN_TTL_MS) continue;
			params.chatRunState.agentDeltaSentAt.delete(key);
			params.chatRunState.bufferedAgentEvents.delete(key);
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
