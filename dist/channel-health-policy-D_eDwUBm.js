//#region src/gateway/channel-health-policy.ts
function isManagedAccount(snapshot) {
	return snapshot.enabled !== false && snapshot.configured !== false;
}
const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 6e4;
const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 30 * 6e4;
const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 12e4;
function evaluateChannelHealth(snapshot, policy) {
	if (!isManagedAccount(snapshot)) return {
		healthy: true,
		reason: "unmanaged"
	};
	if (!snapshot.running) return {
		healthy: false,
		reason: "not-running"
	};
	const activeRuns = typeof snapshot.activeRuns === "number" && Number.isFinite(snapshot.activeRuns) ? Math.max(0, Math.trunc(snapshot.activeRuns)) : 0;
	const isBusy = snapshot.busy === true || activeRuns > 0;
	const lastStartAt = typeof snapshot.lastStartAt === "number" && Number.isFinite(snapshot.lastStartAt) ? snapshot.lastStartAt : null;
	const lastRunActivityAt = typeof snapshot.lastRunActivityAt === "number" && Number.isFinite(snapshot.lastRunActivityAt) ? snapshot.lastRunActivityAt : null;
	const lastTransportActivityAt = typeof snapshot.lastTransportActivityAt === "number" && Number.isFinite(snapshot.lastTransportActivityAt) ? snapshot.lastTransportActivityAt : null;
	const busyStateInitializedForLifecycle = lastStartAt == null || lastRunActivityAt != null && lastRunActivityAt >= lastStartAt;
	if (isBusy) if (!busyStateInitializedForLifecycle) {} else {
		if ((lastRunActivityAt == null ? Number.POSITIVE_INFINITY : Math.max(0, policy.now - lastRunActivityAt)) < BUSY_ACTIVITY_STALE_THRESHOLD_MS) return {
			healthy: true,
			reason: "busy"
		};
		return {
			healthy: false,
			reason: "stuck"
		};
	}
	if (snapshot.lastStartAt != null) {
		if (policy.now - snapshot.lastStartAt < policy.channelConnectGraceMs) return {
			healthy: true,
			reason: "startup-connect-grace"
		};
	}
	if (snapshot.connected === false) return {
		healthy: false,
		reason: "disconnected"
	};
	if (snapshot.connected === true && lastTransportActivityAt != null) {
		if (lastStartAt != null && lastTransportActivityAt < lastStartAt) {
			if (Math.max(0, policy.now - lastStartAt) <= policy.staleEventThresholdMs) return {
				healthy: true,
				reason: "healthy"
			};
			return {
				healthy: false,
				reason: "stale-socket"
			};
		}
		if (policy.now - lastTransportActivityAt > policy.staleEventThresholdMs) return {
			healthy: false,
			reason: "stale-socket"
		};
	}
	return {
		healthy: true,
		reason: "healthy"
	};
}
function resolveChannelRestartReason(snapshot, evaluation) {
	if (evaluation.reason === "stale-socket") return "stale-socket";
	if (evaluation.reason === "not-running") return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
	if (evaluation.reason === "disconnected") return "disconnected";
	return "stuck";
}
//#endregion
export { resolveChannelRestartReason as i, DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS as n, evaluateChannelHealth as r, DEFAULT_CHANNEL_CONNECT_GRACE_MS as t };
