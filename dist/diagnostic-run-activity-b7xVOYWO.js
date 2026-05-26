import { c as onInternalDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
//#region src/logging/diagnostic-run-activity.ts
const activityByRef = /* @__PURE__ */ new Map();
const activityByRunId = /* @__PURE__ */ new Map();
function sessionRefs(params) {
	const refs = [];
	const sessionId = params.sessionId?.trim();
	const sessionKey = params.sessionKey?.trim();
	if (sessionId) refs.push(`id:${sessionId}`);
	if (sessionKey) refs.push(`key:${sessionKey}`);
	return refs;
}
function registerSessionActivityRefs(activity, params) {
	activity.sessionId ??= params.sessionId;
	activity.sessionKey ??= params.sessionKey;
	for (const ref of sessionRefs(params)) activityByRef.set(ref, activity);
	if (params.runId) activityByRunId.set(params.runId, activity);
}
function replaceSessionActivityReferences(source, target) {
	for (const [ref, activity] of activityByRef) if (activity === source) activityByRef.set(ref, target);
	for (const [runId, activity] of activityByRunId) if (activity === source) activityByRunId.set(runId, target);
}
function mergeSessionActivity(target, source) {
	target.sessionId ??= source.sessionId;
	target.sessionKey ??= source.sessionKey;
	for (const key of source.activeEmbeddedRuns) target.activeEmbeddedRuns.add(key);
	for (const [key, tool] of source.activeTools) target.activeTools.set(key, tool);
	for (const call of source.activeModelCalls) target.activeModelCalls.add(call);
	if (source.lastProgressAt > target.lastProgressAt) {
		target.lastProgressAt = source.lastProgressAt;
		target.lastProgressReason = source.lastProgressReason;
	}
	replaceSessionActivityReferences(source, target);
}
function resolveSessionActivity(params) {
	let activity;
	if (params.runId) {
		const byRun = activityByRunId.get(params.runId);
		if (byRun) activity = byRun;
	}
	for (const ref of sessionRefs(params)) {
		const byRef = activityByRef.get(ref);
		if (!byRef) continue;
		if (!activity) activity = byRef;
		else if (activity !== byRef) mergeSessionActivity(activity, byRef);
	}
	if (activity) {
		registerSessionActivityRefs(activity, params);
		return activity;
	}
	if (!params.create) return;
	const created = {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		activeEmbeddedRuns: /* @__PURE__ */ new Set(),
		activeTools: /* @__PURE__ */ new Map(),
		activeModelCalls: /* @__PURE__ */ new Set(),
		lastProgressAt: Date.now()
	};
	registerSessionActivityRefs(created, params);
	return created;
}
function touchSessionActivity(activity, reason, now = Date.now()) {
	activity.lastProgressAt = now;
	activity.lastProgressReason = reason;
}
function toolKey(event) {
	return `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`;
}
function modelCallKey(event) {
	return `${event.runId ?? "unknown"}:${event.provider ?? "provider"}:${event.model ?? "model"}`;
}
function recordToolStarted(event) {
	const activity = resolveSessionActivity({
		...event,
		create: true
	});
	if (!activity) return;
	const now = Date.now();
	activity.activeTools.set(toolKey(event), {
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		startedAt: now,
		lastProgressAt: now
	});
	touchSessionActivity(activity, `tool:${event.toolName}:started`, now);
}
function recordToolEnded(event) {
	const activity = resolveSessionActivity(event);
	if (!activity) return;
	activity.activeTools.delete(toolKey(event));
	touchSessionActivity(activity, `tool:${event.toolName}:ended`);
}
function recordModelStarted(event) {
	const activity = resolveSessionActivity({
		...event,
		create: true
	});
	if (!activity) return;
	activity.activeModelCalls.add(modelCallKey(event));
	touchSessionActivity(activity, "model_call:started");
}
function recordModelEnded(event) {
	const activity = resolveSessionActivity(event);
	if (!activity) return;
	activity.activeModelCalls.delete(modelCallKey(event));
	touchSessionActivity(activity, "model_call:ended");
}
function recordRunProgress(event) {
	const activity = resolveSessionActivity({
		...event,
		create: true
	});
	if (!activity) return;
	touchSessionActivity(activity, event.reason);
}
function recordRunCompleted(event) {
	const activity = resolveSessionActivity(event);
	if (!activity) return;
	activityByRunId.delete(event.runId);
	activity.activeTools.clear();
	activity.activeModelCalls.clear();
	activity.activeEmbeddedRuns.clear();
	touchSessionActivity(activity, "run:completed");
}
function markDiagnosticEmbeddedRunStarted(params) {
	const activity = resolveSessionActivity({
		...params,
		create: true
	});
	if (!activity) return;
	activity.activeEmbeddedRuns.add(resolveEmbeddedRunWorkKey(params));
	touchSessionActivity(activity, "embedded_run:started");
}
function markDiagnosticEmbeddedRunEnded(params) {
	const activity = resolveSessionActivity(params);
	if (!activity) return;
	activity.activeEmbeddedRuns.delete(resolveEmbeddedRunWorkKey(params));
	if (params.clearRunActivity !== false) {
		activity.activeTools.clear();
		activity.activeModelCalls.clear();
	}
	touchSessionActivity(activity, "embedded_run:ended");
}
function resolveEmbeddedRunWorkKey(params) {
	return params.workKey ?? params.sessionId;
}
function getDiagnosticSessionActivitySnapshot(params, now = Date.now()) {
	const activity = resolveSessionActivity(params);
	if (!activity) return {};
	let activeWorkKind;
	if (activity.activeTools.size > 0) activeWorkKind = "tool_call";
	else if (activity.activeModelCalls.size > 0) activeWorkKind = "model_call";
	else if (activity.activeEmbeddedRuns.size > 0) activeWorkKind = "embedded_run";
	let activeTool;
	for (const tool of activity.activeTools.values()) if (!activeTool || tool.startedAt < activeTool.startedAt) activeTool = tool;
	return {
		activeWorkKind,
		...activity.activeEmbeddedRuns.size > 0 ? { hasActiveEmbeddedRun: true } : {},
		activeToolName: activeTool?.toolName,
		activeToolCallId: activeTool?.toolCallId,
		activeToolAgeMs: activeTool ? Math.max(0, now - activeTool.startedAt) : void 0,
		lastProgressAgeMs: Math.max(0, now - activity.lastProgressAt),
		lastProgressReason: activity.lastProgressReason
	};
}
function resetDiagnosticRunActivityForTest() {
	activityByRef.clear();
	activityByRunId.clear();
}
onInternalDiagnosticEvent((event) => {
	switch (event.type) {
		case "tool.execution.started":
			recordToolStarted(event);
			return;
		case "tool.execution.completed":
		case "tool.execution.error":
		case "tool.execution.blocked":
			recordToolEnded(event);
			return;
		case "model.call.started":
			recordModelStarted(event);
			return;
		case "model.call.completed":
		case "model.call.error":
			recordModelEnded(event);
			return;
		case "run.progress":
			recordRunProgress(event);
			return;
		case "run.completed":
			recordRunCompleted(event);
			return;
		default: return;
	}
});
//#endregion
export { resetDiagnosticRunActivityForTest as i, markDiagnosticEmbeddedRunEnded as n, markDiagnosticEmbeddedRunStarted as r, getDiagnosticSessionActivitySnapshot as t };
