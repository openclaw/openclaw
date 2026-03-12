import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { s as createSubsystemLogger } from "./entry.js";
import { i as pruneDiagnosticSessionStates, r as getDiagnosticSessionState, t as diagnosticSessionStates } from "./diagnostic-session-state-Cw3EMvZy.js";

//#region src/infra/diagnostic-events.ts
function getDiagnosticEventsState() {
	const globalStore = globalThis;
	if (!globalStore.__openclawDiagnosticEventsState) globalStore.__openclawDiagnosticEventsState = {
		seq: 0,
		listeners: /* @__PURE__ */ new Set(),
		dispatchDepth: 0
	};
	return globalStore.__openclawDiagnosticEventsState;
}
function isDiagnosticsEnabled(config) {
	return config?.diagnostics?.enabled === true;
}
function emitDiagnosticEvent(event) {
	const state = getDiagnosticEventsState();
	if (state.dispatchDepth > 100) {
		console.error(`[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${event.type}`);
		return;
	}
	const enriched = {
		...event,
		seq: state.seq += 1,
		ts: Date.now()
	};
	state.dispatchDepth += 1;
	for (const listener of state.listeners) try {
		listener(enriched);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.stack ?? err.message : typeof err === "string" ? err : String(err);
		console.error(`[diagnostic-events] listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`);
	}
	state.dispatchDepth -= 1;
}

//#endregion
//#region src/logging/diagnostic.ts
var diagnostic_exports = /* @__PURE__ */ __exportAll({
	diagnosticLogger: () => diag,
	logLaneDequeue: () => logLaneDequeue,
	logLaneEnqueue: () => logLaneEnqueue,
	logMessageProcessed: () => logMessageProcessed,
	logMessageQueued: () => logMessageQueued,
	logSessionStateChange: () => logSessionStateChange,
	logSessionStuck: () => logSessionStuck,
	logToolLoopAction: () => logToolLoopAction,
	logWebhookError: () => logWebhookError,
	logWebhookProcessed: () => logWebhookProcessed,
	logWebhookReceived: () => logWebhookReceived,
	startDiagnosticHeartbeat: () => startDiagnosticHeartbeat,
	stopDiagnosticHeartbeat: () => stopDiagnosticHeartbeat
});
const diag = createSubsystemLogger("diagnostic");
const webhookStats = {
	received: 0,
	processed: 0,
	errors: 0,
	lastReceived: 0
};
let lastActivityAt = 0;
function markActivity() {
	lastActivityAt = Date.now();
}
function logWebhookReceived(params) {
	webhookStats.received += 1;
	webhookStats.lastReceived = Date.now();
	if (diag.isEnabled("debug")) diag.debug(`webhook received: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${params.chatId ?? "unknown"} total=${webhookStats.received}`);
	emitDiagnosticEvent({
		type: "webhook.received",
		channel: params.channel,
		updateType: params.updateType,
		chatId: params.chatId
	});
	markActivity();
}
function logWebhookProcessed(params) {
	webhookStats.processed += 1;
	if (diag.isEnabled("debug")) diag.debug(`webhook processed: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${params.chatId ?? "unknown"} duration=${params.durationMs ?? 0}ms processed=${webhookStats.processed}`);
	emitDiagnosticEvent({
		type: "webhook.processed",
		channel: params.channel,
		updateType: params.updateType,
		chatId: params.chatId,
		durationMs: params.durationMs
	});
	markActivity();
}
function logWebhookError(params) {
	webhookStats.errors += 1;
	diag.error(`webhook error: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${params.chatId ?? "unknown"} error="${params.error}" errors=${webhookStats.errors}`);
	emitDiagnosticEvent({
		type: "webhook.error",
		channel: params.channel,
		updateType: params.updateType,
		chatId: params.chatId,
		error: params.error
	});
	markActivity();
}
function logMessageQueued(params) {
	const state = getDiagnosticSessionState(params);
	state.queueDepth += 1;
	state.lastActivity = Date.now();
	if (diag.isEnabled("debug")) diag.debug(`message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${state.sessionKey ?? "unknown"} source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`);
	emitDiagnosticEvent({
		type: "message.queued",
		sessionId: state.sessionId,
		sessionKey: state.sessionKey,
		channel: params.channel,
		source: params.source,
		queueDepth: state.queueDepth
	});
	markActivity();
}
function logMessageProcessed(params) {
	if (params.outcome === "error" ? diag.isEnabled("error") : diag.isEnabled("debug")) {
		const payload = `message processed: channel=${params.channel} chatId=${params.chatId ?? "unknown"} messageId=${params.messageId ?? "unknown"} sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} duration=${params.durationMs ?? 0}ms${params.reason ? ` reason=${params.reason}` : ""}${params.error ? ` error="${params.error}"` : ""}`;
		if (params.outcome === "error") diag.error(payload);
		else diag.debug(payload);
	}
	emitDiagnosticEvent({
		type: "message.processed",
		channel: params.channel,
		chatId: params.chatId,
		messageId: params.messageId,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		durationMs: params.durationMs,
		outcome: params.outcome,
		reason: params.reason,
		error: params.error
	});
	markActivity();
}
function logSessionStateChange(params) {
	const state = getDiagnosticSessionState(params);
	const isProbeSession = state.sessionId?.startsWith("probe-") ?? false;
	const prevState = state.state;
	state.state = params.state;
	state.lastActivity = Date.now();
	if (params.state === "idle") state.queueDepth = Math.max(0, state.queueDepth - 1);
	if (!isProbeSession && diag.isEnabled("debug")) diag.debug(`session state: sessionId=${state.sessionId ?? "unknown"} sessionKey=${state.sessionKey ?? "unknown"} prev=${prevState} new=${params.state} reason="${params.reason ?? ""}" queueDepth=${state.queueDepth}`);
	emitDiagnosticEvent({
		type: "session.state",
		sessionId: state.sessionId,
		sessionKey: state.sessionKey,
		prevState,
		state: params.state,
		reason: params.reason,
		queueDepth: state.queueDepth
	});
	markActivity();
}
function logSessionStuck(params) {
	const state = getDiagnosticSessionState(params);
	diag.warn(`stuck session: sessionId=${state.sessionId ?? "unknown"} sessionKey=${state.sessionKey ?? "unknown"} state=${params.state} age=${Math.round(params.ageMs / 1e3)}s queueDepth=${state.queueDepth}`);
	emitDiagnosticEvent({
		type: "session.stuck",
		sessionId: state.sessionId,
		sessionKey: state.sessionKey,
		state: params.state,
		ageMs: params.ageMs,
		queueDepth: state.queueDepth
	});
	markActivity();
}
function logLaneEnqueue(lane, queueSize) {
	diag.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
	emitDiagnosticEvent({
		type: "queue.lane.enqueue",
		lane,
		queueSize
	});
	markActivity();
}
function logLaneDequeue(lane, waitMs, queueSize) {
	diag.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
	emitDiagnosticEvent({
		type: "queue.lane.dequeue",
		lane,
		queueSize,
		waitMs
	});
	markActivity();
}
function logToolLoopAction(params) {
	const payload = `tool loop: sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} tool=${params.toolName} level=${params.level} action=${params.action} detector=${params.detector} count=${params.count}${params.pairedToolName ? ` pairedTool=${params.pairedToolName}` : ""} message="${params.message}"`;
	if (params.level === "critical") diag.error(payload);
	else diag.warn(payload);
	emitDiagnosticEvent({
		type: "tool.loop",
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		toolName: params.toolName,
		level: params.level,
		action: params.action,
		detector: params.detector,
		count: params.count,
		message: params.message,
		pairedToolName: params.pairedToolName
	});
	markActivity();
}
let heartbeatInterval = null;
function startDiagnosticHeartbeat() {
	if (heartbeatInterval) return;
	heartbeatInterval = setInterval(() => {
		const now = Date.now();
		pruneDiagnosticSessionStates(now, true);
		const activeCount = Array.from(diagnosticSessionStates.values()).filter((s) => s.state === "processing").length;
		const waitingCount = Array.from(diagnosticSessionStates.values()).filter((s) => s.state === "waiting").length;
		const totalQueued = Array.from(diagnosticSessionStates.values()).reduce((sum, s) => sum + s.queueDepth, 0);
		if (!(lastActivityAt > 0 || webhookStats.received > 0 || activeCount > 0 || waitingCount > 0 || totalQueued > 0)) return;
		if (now - lastActivityAt > 12e4 && activeCount === 0 && waitingCount === 0) return;
		diag.debug(`heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${activeCount} waiting=${waitingCount} queued=${totalQueued}`);
		emitDiagnosticEvent({
			type: "diagnostic.heartbeat",
			webhooks: {
				received: webhookStats.received,
				processed: webhookStats.processed,
				errors: webhookStats.errors
			},
			active: activeCount,
			waiting: waitingCount,
			queued: totalQueued
		});
		import("./command-poll-backoff-Dyk_JaIm.js").then((n) => n.t).then(({ pruneStaleCommandPolls }) => {
			for (const [, state] of diagnosticSessionStates) pruneStaleCommandPolls(state);
		}).catch((err) => {
			diag.debug(`command-poll-backoff prune failed: ${String(err)}`);
		});
		for (const [, state] of diagnosticSessionStates) {
			const ageMs = now - state.lastActivity;
			if (state.state === "processing" && ageMs > 12e4) logSessionStuck({
				sessionId: state.sessionId,
				sessionKey: state.sessionKey,
				state: state.state,
				ageMs
			});
		}
	}, 3e4);
	heartbeatInterval.unref?.();
}
function stopDiagnosticHeartbeat() {
	if (heartbeatInterval) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
	}
}

//#endregion
export { logMessageProcessed as a, logWebhookError as c, startDiagnosticHeartbeat as d, stopDiagnosticHeartbeat as f, logLaneEnqueue as i, logWebhookProcessed as l, isDiagnosticsEnabled as m, diagnostic_exports as n, logMessageQueued as o, emitDiagnosticEvent as p, logLaneDequeue as r, logSessionStateChange as s, diag as t, logWebhookReceived as u };