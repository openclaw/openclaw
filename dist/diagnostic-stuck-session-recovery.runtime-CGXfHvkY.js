import { C as formatStoppedCronSessionDiagnosticFields, S as formatRecoveryOutcome, w as resolveCronSessionDiagnosticContext } from "./diagnostic-DEgTYLXt.js";
import { t as diagnosticLogger } from "./diagnostic-runtime-fqnhjrAV.js";
import { i as isDiagnosticSessionStateCurrent } from "./diagnostic-session-state-BO6_8hHT.js";
import { f as resolveActiveEmbeddedRunHandleSessionId, o as isEmbeddedPiRunActive, p as resolveActiveEmbeddedRunSessionId, s as isEmbeddedPiRunHandleActive, t as abortAndDrainEmbeddedPiRun } from "./runs-DrbsiywK.js";
import { o as getCommandLaneSnapshot, p as resetCommandLane } from "./command-queue-Da2Lh3Ua.js";
import { t as resolveEmbeddedSessionLane } from "./lanes-BrQRlRRS.js";
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
	if (!key || recoveriesInFlight.has(key)) return {
		status: "skipped",
		action: "observe_only",
		reason: key ? "already_in_flight" : "missing_session_ref",
		sessionId: params.sessionId,
		sessionKey: params.sessionKey
	};
	recoveriesInFlight.add(key);
	try {
		if (!isDiagnosticSessionStateCurrent({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			generation: params.stateGeneration,
			state: params.expectedState ?? "processing"
		})) return {
			status: "skipped",
			action: "observe_only",
			reason: "stale_session_state",
			sessionId: params.sessionId,
			sessionKey: params.sessionKey
		};
		const fallbackActiveSessionId = params.sessionId && isEmbeddedPiRunHandleActive(params.sessionId) ? params.sessionId : void 0;
		let activeSessionId = params.sessionKey ? resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) ?? fallbackActiveSessionId : fallbackActiveSessionId;
		const activeWorkSessionId = params.sessionKey ? resolveActiveEmbeddedRunSessionId(params.sessionKey) ?? params.sessionId : params.sessionId;
		const laneKey = params.sessionKey?.trim() || params.sessionId?.trim();
		const sessionLane = laneKey ? resolveEmbeddedSessionLane(laneKey) : null;
		let aborted = false;
		let drained = true;
		let forceCleared = false;
		if (activeSessionId) {
			if (params.allowActiveAbort !== true) {
				const outcome = {
					status: "skipped",
					action: "observe_only",
					reason: "active_embedded_run",
					sessionId: params.sessionId,
					sessionKey: params.sessionKey,
					activeSessionId,
					activeWorkKind: "embedded_run"
				};
				diagnosticLogger.warn(`stuck session recovery skipped: ${formatRecoveryContext(params, { activeSessionId })}`);
				diagnosticLogger.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
				return outcome;
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
			forceCleared = result.forceCleared;
		}
		if (!activeSessionId && activeWorkSessionId && isEmbeddedPiRunActive(activeWorkSessionId)) if (params.allowActiveAbort === true) {
			const result = await abortAndDrainEmbeddedPiRun({
				sessionId: activeWorkSessionId,
				sessionKey: params.sessionKey,
				settleMs: STUCK_SESSION_ABORT_SETTLE_MS,
				forceClear: true,
				reason: "stuck_recovery"
			});
			aborted = result.aborted;
			drained = result.drained;
			forceCleared = result.forceCleared;
			activeSessionId = activeWorkSessionId;
		} else {
			const outcome = {
				status: "skipped",
				action: "keep_lane",
				reason: "active_reply_work",
				sessionId: params.sessionId,
				sessionKey: params.sessionKey,
				activeSessionId: activeWorkSessionId,
				activeWorkKind: "embedded_run"
			};
			diagnosticLogger.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
			return outcome;
		}
		if (!activeSessionId && sessionLane) {
			const laneSnapshot = getCommandLaneSnapshot(sessionLane);
			if (laneSnapshot.activeCount > 0) {
				const outcome = {
					status: "skipped",
					action: "keep_lane",
					reason: "active_lane_task",
					sessionId: params.sessionId,
					sessionKey: params.sessionKey,
					lane: sessionLane,
					activeCount: laneSnapshot.activeCount,
					queuedCount: laneSnapshot.queuedCount
				};
				diagnosticLogger.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
				return outcome;
			}
		}
		const queuedCount = sessionLane ? getCommandLaneSnapshot(sessionLane).queuedCount : 0;
		const released = sessionLane && (!activeSessionId || !aborted || !drained) ? resetCommandLane(sessionLane) : 0;
		const clearStaleQueuedSession = !aborted && released === 0 && (params.queueDepth ?? 0) > 0;
		if (aborted || forceCleared || released > 0 || clearStaleQueuedSession) {
			const action = aborted || forceCleared ? "abort_embedded_run" : "release_lane";
			const stoppedFields = formatStoppedCronSessionDiagnosticFields(resolveCronSessionDiagnosticContext({
				sessionKey: params.sessionKey,
				activeSessionId
			}));
			diagnosticLogger.warn(`stuck session recovery: sessionId=${params.sessionId ?? activeSessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} age=${Math.round(params.ageMs / 1e3)}s action=${action} aborted=${aborted} drained=${drained} released=${released}${stoppedFields ? ` ${stoppedFields}` : ""}`);
			const outcome = aborted || forceCleared ? {
				status: "aborted",
				action: "abort_embedded_run",
				sessionId: params.sessionId,
				sessionKey: params.sessionKey,
				activeSessionId,
				activeWorkKind: "embedded_run",
				aborted,
				drained,
				forceCleared,
				released,
				lane: sessionLane ?? void 0,
				...queuedCount > 0 ? { queuedCount } : {}
			} : {
				status: "released",
				action: "release_lane",
				sessionId: params.sessionId,
				sessionKey: params.sessionKey,
				released,
				lane: sessionLane ?? void 0
			};
			diagnosticLogger.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
			return outcome;
		}
		const outcome = {
			status: "noop",
			action: "none",
			reason: "no_active_work",
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			lane: sessionLane ?? void 0
		};
		diagnosticLogger.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
		return outcome;
	} catch (err) {
		const outcome = {
			status: "failed",
			action: "none",
			reason: "exception",
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			error: String(err)
		};
		diagnosticLogger.warn(`stuck session recovery failed: sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} err=${String(err)}`);
		return outcome;
	} finally {
		recoveriesInFlight.delete(key);
	}
}
const testing = { resetRecoveriesInFlight() {
	recoveriesInFlight.clear();
} };
//#endregion
export { testing as __testing, testing, recoverStuckDiagnosticSession };
