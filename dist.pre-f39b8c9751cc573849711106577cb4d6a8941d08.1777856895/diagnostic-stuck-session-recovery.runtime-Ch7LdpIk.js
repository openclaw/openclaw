import { d as resolveActiveEmbeddedRunSessionId, o as isEmbeddedPiRunActive, s as isEmbeddedPiRunHandleActive, t as abortAndDrainEmbeddedPiRun, u as resolveActiveEmbeddedRunHandleSessionId } from "./runs-CSw2NUeT.js";
import { t as diagnosticLogger } from "./diagnostic-runtime-BvYl76jm.js";
import { f as resetCommandLane, o as getCommandLaneSnapshot } from "./command-queue-QKZipqu-.js";
import { t as resolveEmbeddedSessionLane } from "./lanes-BsuqEZAj.js";
//#region src/logging/diagnostic-stuck-session-recovery.runtime.ts
const STUCK_SESSION_ABORT_SETTLE_MS = 15e3;
const recoveriesInFlight = /* @__PURE__ */ new Set();
function recoveryKey(params) {
	return params.sessionKey?.trim() || params.sessionId?.trim() || void 0;
}
function formatRecoveryContext(params, extra) {
	const fields = [
		`sessionId=${params.sessionId ?? extra?.activeSessionId ?? "unknown"}`,
		`sessionKey=${params.sessionKey ?? "unknown"}`,
		`age=${Math.round(params.ageMs / 1e3)}s`,
		`queueDepth=${params.queueDepth ?? 0}`
	];
	if (extra?.activeSessionId) fields.push(`activeSessionId=${extra.activeSessionId}`);
	if (extra?.lane) fields.push(`lane=${extra.lane}`);
	if (extra?.activeCount !== void 0) fields.push(`laneActive=${extra.activeCount}`);
	if (extra?.queuedCount !== void 0) fields.push(`laneQueued=${extra.queuedCount}`);
	return fields.join(" ");
}
async function recoverStuckDiagnosticSession(params) {
	const key = recoveryKey(params);
	if (!key || recoveriesInFlight.has(key)) return;
	recoveriesInFlight.add(key);
	try {
		const fallbackActiveSessionId = params.sessionId && isEmbeddedPiRunHandleActive(params.sessionId) ? params.sessionId : void 0;
		const activeSessionId = params.sessionKey ? resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) ?? fallbackActiveSessionId : fallbackActiveSessionId;
		const activeWorkSessionId = params.sessionKey ? resolveActiveEmbeddedRunSessionId(params.sessionKey) ?? params.sessionId : params.sessionId;
		const laneKey = params.sessionKey?.trim() || params.sessionId?.trim();
		const sessionLane = laneKey ? resolveEmbeddedSessionLane(laneKey) : null;
		let aborted = false;
		let drained = true;
		if (activeSessionId) {
			if (params.allowActiveAbort !== true) {
				diagnosticLogger.warn(`stuck session recovery skipped: reason=active_embedded_run action=observe_only ${formatRecoveryContext(params, { activeSessionId })}`);
				return;
			}
			const result = await abortAndDrainEmbeddedPiRun({
				sessionId: activeSessionId,
				sessionKey: params.sessionKey,
				settleMs: STUCK_SESSION_ABORT_SETTLE_MS,
				forceClear: true,
				reason: "stuck_recovery"
			});
			aborted = result.aborted;
			drained = result.drained;
		}
		if (!activeSessionId && activeWorkSessionId && isEmbeddedPiRunActive(activeWorkSessionId)) {
			diagnosticLogger.warn(`stuck session recovery skipped: reason=active_reply_work action=keep_lane ${formatRecoveryContext(params, { activeSessionId: activeWorkSessionId })}`);
			return;
		}
		if (!activeSessionId && sessionLane) {
			const laneSnapshot = getCommandLaneSnapshot(sessionLane);
			if (laneSnapshot.activeCount > 0) {
				diagnosticLogger.warn(`stuck session recovery skipped: reason=active_lane_task action=keep_lane ${formatRecoveryContext(params, {
					lane: sessionLane,
					activeCount: laneSnapshot.activeCount,
					queuedCount: laneSnapshot.queuedCount
				})}`);
				return;
			}
		}
		const released = sessionLane && (!activeSessionId || !aborted || !drained) ? resetCommandLane(sessionLane) : 0;
		if (aborted || released > 0) diagnosticLogger.warn(`stuck session recovery: sessionId=${params.sessionId ?? activeSessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} age=${Math.round(params.ageMs / 1e3)}s aborted=${aborted} drained=${drained} released=${released}`);
		else diagnosticLogger.warn(`stuck session recovery no-op: reason=no_active_work action=none ${formatRecoveryContext(params, { lane: sessionLane ?? void 0 })}`);
	} catch (err) {
		diagnosticLogger.warn(`stuck session recovery failed: sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} err=${String(err)}`);
	} finally {
		recoveriesInFlight.delete(key);
	}
}
const __testing = { resetRecoveriesInFlight() {
	recoveriesInFlight.clear();
} };
//#endregion
export { __testing, recoverStuckDiagnosticSession };
