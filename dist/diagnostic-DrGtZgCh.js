import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { a as isDiagnosticsEnabled, n as emitDiagnosticEvent, s as onInternalDiagnosticEvent, t as areDiagnosticsEnabledForProcess } from "./diagnostic-events-BkhOFI0h.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import "./config-CzeRK-GW.js";
import { n as getRecentDiagnosticPhases, r as resetDiagnosticPhasesForTest, t as getCurrentDiagnosticPhase } from "./diagnostic-phase-C9qxy_9I.js";
import { a as markDiagnosticActivity, n as getLastDiagnosticActivityAt, o as resetDiagnosticActivityForTest, t as diagnosticLogger } from "./diagnostic-runtime-BO7pkiQC.js";
import { a as pruneDiagnosticSessionStates, i as isDiagnosticSessionStateCurrent, n as getDiagnosticSessionState, o as resetDiagnosticSessionStateForTest, r as getDiagnosticSessionStateCountForTest$1, t as diagnosticSessionStates } from "./diagnostic-session-state-CaS7Cm25.js";
import { i as resetDiagnosticStabilityRecorderForTest, o as startDiagnosticStabilityRecorder, s as stopDiagnosticStabilityRecorder } from "./diagnostic-stability-BC36t-9c.js";
import { a as installDiagnosticStabilityFatalHook, d as uninstallDiagnosticStabilityFatalHook, l as resetDiagnosticStabilityBundleForTest } from "./diagnostic-stability-bundle-DLQkfhfT.js";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
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
	target.activeEmbeddedRun ||= source.activeEmbeddedRun;
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
		activeEmbeddedRun: false,
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
	activity.activeEmbeddedRun = false;
	touchSessionActivity(activity, "run:completed");
}
function markDiagnosticEmbeddedRunStarted(params) {
	const activity = resolveSessionActivity({
		...params,
		create: true
	});
	if (!activity) return;
	activity.activeEmbeddedRun = true;
	touchSessionActivity(activity, "embedded_run:started");
}
function markDiagnosticEmbeddedRunEnded(params) {
	const activity = resolveSessionActivity(params);
	if (!activity) return;
	activity.activeEmbeddedRun = false;
	activity.activeTools.clear();
	activity.activeModelCalls.clear();
	touchSessionActivity(activity, "embedded_run:ended");
}
function getDiagnosticSessionActivitySnapshot(params, now = Date.now()) {
	const activity = resolveSessionActivity(params);
	if (!activity) return {};
	let activeWorkKind;
	if (activity.activeTools.size > 0) activeWorkKind = "tool_call";
	else if (activity.activeModelCalls.size > 0) activeWorkKind = "model_call";
	else if (activity.activeEmbeddedRun) activeWorkKind = "embedded_run";
	let activeTool;
	for (const tool of activity.activeTools.values()) if (!activeTool || tool.startedAt < activeTool.startedAt) activeTool = tool;
	return {
		activeWorkKind,
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
//#region src/logging/diagnostic-memory.ts
const MB = 1024 * 1024;
const DEFAULT_RSS_WARNING_BYTES = 1536 * MB;
const DEFAULT_RSS_CRITICAL_BYTES = 3072 * MB;
const DEFAULT_HEAP_WARNING_BYTES = 1024 * MB;
const DEFAULT_HEAP_CRITICAL_BYTES = 2048 * MB;
const DEFAULT_RSS_GROWTH_WARNING_BYTES = 512 * MB;
const DEFAULT_RSS_GROWTH_CRITICAL_BYTES = 1024 * MB;
const DEFAULT_GROWTH_WINDOW_MS = 600 * 1e3;
const DEFAULT_PRESSURE_REPEAT_MS = 300 * 1e3;
const state = {
	lastSample: null,
	lastPressureAtByKey: /* @__PURE__ */ new Map()
};
function normalizeMemoryUsage(memory) {
	return {
		rssBytes: memory.rss,
		heapTotalBytes: memory.heapTotal,
		heapUsedBytes: memory.heapUsed,
		externalBytes: memory.external,
		arrayBuffersBytes: memory.arrayBuffers
	};
}
function resolveThresholds(thresholds) {
	return {
		rssWarningBytes: thresholds?.rssWarningBytes ?? DEFAULT_RSS_WARNING_BYTES,
		rssCriticalBytes: thresholds?.rssCriticalBytes ?? DEFAULT_RSS_CRITICAL_BYTES,
		heapUsedWarningBytes: thresholds?.heapUsedWarningBytes ?? DEFAULT_HEAP_WARNING_BYTES,
		heapUsedCriticalBytes: thresholds?.heapUsedCriticalBytes ?? DEFAULT_HEAP_CRITICAL_BYTES,
		rssGrowthWarningBytes: thresholds?.rssGrowthWarningBytes ?? DEFAULT_RSS_GROWTH_WARNING_BYTES,
		rssGrowthCriticalBytes: thresholds?.rssGrowthCriticalBytes ?? DEFAULT_RSS_GROWTH_CRITICAL_BYTES,
		growthWindowMs: thresholds?.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS,
		pressureRepeatMs: thresholds?.pressureRepeatMs ?? DEFAULT_PRESSURE_REPEAT_MS
	};
}
function pickThresholdPressure(params) {
	const { memory, thresholds } = params;
	if (memory.rssBytes >= thresholds.rssCriticalBytes) return {
		level: "critical",
		reason: "rss_threshold",
		memory,
		thresholdBytes: thresholds.rssCriticalBytes
	};
	if (memory.heapUsedBytes >= thresholds.heapUsedCriticalBytes) return {
		level: "critical",
		reason: "heap_threshold",
		memory,
		thresholdBytes: thresholds.heapUsedCriticalBytes
	};
	if (memory.rssBytes >= thresholds.rssWarningBytes) return {
		level: "warning",
		reason: "rss_threshold",
		memory,
		thresholdBytes: thresholds.rssWarningBytes
	};
	if (memory.heapUsedBytes >= thresholds.heapUsedWarningBytes) return {
		level: "warning",
		reason: "heap_threshold",
		memory,
		thresholdBytes: thresholds.heapUsedWarningBytes
	};
	return null;
}
function pickGrowthPressure(params) {
	const { previous, current, thresholds } = params;
	if (!previous) return null;
	const windowMs = current.ts - previous.ts;
	if (windowMs <= 0 || windowMs > thresholds.growthWindowMs) return null;
	const rssGrowthBytes = current.memory.rssBytes - previous.memory.rssBytes;
	if (rssGrowthBytes >= thresholds.rssGrowthCriticalBytes) return {
		level: "critical",
		reason: "rss_growth",
		memory: current.memory,
		thresholdBytes: thresholds.rssGrowthCriticalBytes,
		rssGrowthBytes,
		windowMs
	};
	if (rssGrowthBytes >= thresholds.rssGrowthWarningBytes) return {
		level: "warning",
		reason: "rss_growth",
		memory: current.memory,
		thresholdBytes: thresholds.rssGrowthWarningBytes,
		rssGrowthBytes,
		windowMs
	};
	return null;
}
function shouldEmitPressure(pressure, now, repeatMs) {
	const key = `${pressure.level}:${pressure.reason}`;
	const lastAt = state.lastPressureAtByKey.get(key);
	if (lastAt !== void 0 && now - lastAt < repeatMs) return false;
	state.lastPressureAtByKey.set(key, now);
	return true;
}
function emitDiagnosticMemorySample(options) {
	const now = options?.now ?? Date.now();
	const memory = normalizeMemoryUsage(options?.memoryUsage ?? process.memoryUsage());
	const current = {
		ts: now,
		memory
	};
	const thresholds = resolveThresholds(options?.thresholds);
	if (options?.emitSample !== false) emitDiagnosticEvent({
		type: "diagnostic.memory.sample",
		memory,
		uptimeMs: options?.uptimeMs ?? Math.round(process.uptime() * 1e3)
	});
	const pressure = pickThresholdPressure({
		memory,
		thresholds
	}) ?? pickGrowthPressure({
		previous: state.lastSample,
		current,
		thresholds
	});
	state.lastSample = current;
	if (pressure && shouldEmitPressure(pressure, now, thresholds.pressureRepeatMs)) emitDiagnosticEvent({
		type: "diagnostic.memory.pressure",
		...pressure
	});
	return memory;
}
function resetDiagnosticMemoryForTest() {
	state.lastSample = null;
	state.lastPressureAtByKey.clear();
}
//#endregion
//#region src/logging/diagnostic-session-attention.ts
function classifySessionAttention(params) {
	if (params.activity.activeWorkKind) {
		if (params.activity.activeWorkKind === "tool_call" && (params.activity.activeToolAgeMs ?? 0) > params.staleMs && (params.activity.lastProgressAgeMs ?? 0) > params.staleMs) return {
			eventType: "session.stalled",
			reason: "blocked_tool_call",
			classification: "blocked_tool_call",
			activeWorkKind: params.activity.activeWorkKind,
			recoveryEligible: false
		};
		if ((params.activity.lastProgressAgeMs ?? 0) > params.staleMs) return {
			eventType: "session.stalled",
			reason: "active_work_without_progress",
			classification: "stalled_agent_run",
			activeWorkKind: params.activity.activeWorkKind,
			recoveryEligible: false
		};
		return {
			eventType: "session.long_running",
			reason: params.queueDepth > 0 ? "queued_behind_active_work" : "active_work",
			classification: "long_running",
			activeWorkKind: params.activity.activeWorkKind,
			recoveryEligible: false
		};
	}
	return {
		eventType: "session.stuck",
		reason: params.queueDepth > 0 ? "queued_work_without_active_run" : "stale_session_state",
		classification: "stale_session_state",
		recoveryEligible: true
	};
}
//#endregion
//#region src/logging/diagnostic-session-context.ts
const SESSION_TAIL_BYTES = 64 * 1024;
const MAX_QUOTED_FIELD_CHARS = 140;
function quoteLogField(value) {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return `"${(oneLine.length > MAX_QUOTED_FIELD_CHARS ? `${oneLine.slice(0, Math.max(0, MAX_QUOTED_FIELD_CHARS - 3))}...` : oneLine).replace(/["\\]/g, "\\$&")}"`;
}
function parseCronRunSessionKey(sessionKey) {
	const parts = sessionKey?.trim().split(":") ?? [];
	if (parts[0] !== "agent") return {};
	const cronIndex = parts.indexOf("cron");
	if (cronIndex < 2) return {};
	const runIndex = parts.indexOf("run", cronIndex + 2);
	return {
		agentId: parts[1],
		cronJobId: parts[cronIndex + 1],
		cronRunId: runIndex >= 0 ? parts[runIndex + 1] : void 0
	};
}
function resolveSessionFile(params) {
	const agentId = params.agentId?.trim();
	const runId = params.activeSessionId?.trim() || params.cronRunId?.trim();
	if (!agentId || !runId) return;
	return path.join(resolveStateDir(), "agents", agentId, "sessions", `${runId}.jsonl`);
}
function readTailText(filePath) {
	let fd;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size <= 0) return;
		const length = Math.min(stat.size, SESSION_TAIL_BYTES);
		const start = Math.max(0, stat.size - length);
		const buffer = Buffer.alloc(length);
		fd = fs.openSync(filePath, "r");
		const read = fs.readSync(fd, buffer, 0, length, start);
		return {
			text: buffer.subarray(0, read).toString("utf8"),
			truncated: start > 0
		};
	} catch {
		return;
	} finally {
		if (fd !== void 0) try {
			fs.closeSync(fd);
		} catch {}
	}
}
function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return;
	const texts = content.map((part) => {
		if (!part || typeof part !== "object") return;
		const text = part.text;
		return typeof text === "string" ? text : void 0;
	}).filter((text) => Boolean(text?.trim()));
	return texts.length ? texts.join(" ") : void 0;
}
function readLastAssistantFromSessionFile(filePath) {
	if (!filePath) return;
	const tail = readTailText(filePath);
	if (!tail?.text) return;
	const lines = tail.text.split(/\r?\n/).filter(Boolean);
	if (tail.truncated && lines.length > 0) lines.shift();
	for (let index = lines.length - 1; index >= 0; index -= 1) try {
		const parsed = JSON.parse(lines[index]);
		if (parsed.message?.role !== "assistant") continue;
		const text = textFromContent(parsed.message.content)?.trim();
		if (text) return text;
	} catch {}
}
function readCronJobName(cronJobId) {
	if (!cronJobId) return;
	try {
		const raw = fs.readFileSync(path.join(resolveStateDir(), "cron", "jobs.json"), "utf8");
		const job = JSON.parse(raw).jobs?.find((entry) => entry.id === cronJobId);
		return typeof job?.name === "string" && job.name.trim() ? job.name.trim() : void 0;
	} catch {
		return;
	}
}
function resolveCronSessionDiagnosticContext(params) {
	const parsed = parseCronRunSessionKey(params.sessionKey);
	if (!parsed.cronJobId && !parsed.cronRunId) return {};
	return {
		...parsed,
		cronJobName: readCronJobName(parsed.cronJobId),
		lastAssistant: readLastAssistantFromSessionFile(resolveSessionFile({
			...parsed,
			activeSessionId: params.activeSessionId
		}))
	};
}
function formatCronSessionDiagnosticFields(context) {
	const fields = [];
	if (context.cronJobId) fields.push(`cronJobId=${context.cronJobId}`);
	if (context.cronRunId) fields.push(`cronRunId=${context.cronRunId}`);
	if (context.cronJobName) fields.push(`cronJob=${quoteLogField(context.cronJobName)}`);
	if (context.lastAssistant) fields.push(`lastAssistant=${quoteLogField(context.lastAssistant)}`);
	return fields.join(" ");
}
function formatStoppedCronSessionDiagnosticFields(context) {
	const fields = [];
	if (context.cronJobName) fields.push(`stopped=${quoteLogField(context.cronJobName)}`);
	const rest = formatCronSessionDiagnosticFields({
		cronJobId: context.cronJobId,
		cronRunId: context.cronRunId,
		lastAssistant: context.lastAssistant
	});
	if (rest) fields.push(rest);
	return fields.join(" ");
}
//#endregion
//#region src/logging/diagnostic-session-recovery.ts
function recoveryOutcomeMutatesSessionState(outcome) {
	if (!outcome) return false;
	return outcome.status === "aborted" || outcome.status === "released";
}
function recoveryOutcomeReleasedCount(outcome) {
	return "released" in outcome ? outcome.released : 0;
}
function formatRecoveryOutcome(outcome) {
	const fields = [
		`status=${outcome.status}`,
		`action=${outcome.action}`,
		`sessionId=${outcome.sessionId ?? outcome.activeSessionId ?? "unknown"}`,
		`sessionKey=${outcome.sessionKey ?? "unknown"}`
	];
	if (outcome.activeSessionId) fields.push(`activeSessionId=${outcome.activeSessionId}`);
	if (outcome.activeWorkKind) fields.push(`activeWorkKind=${outcome.activeWorkKind}`);
	if (outcome.lane) fields.push(`lane=${outcome.lane}`);
	if ("reason" in outcome) fields.push(`reason=${outcome.reason}`);
	if ("aborted" in outcome) fields.push(`aborted=${outcome.aborted}`, `drained=${outcome.drained}`, `forceCleared=${outcome.forceCleared}`);
	if ("released" in outcome) fields.push(`released=${outcome.released}`);
	if ("activeCount" in outcome && outcome.activeCount !== void 0) fields.push(`laneActive=${outcome.activeCount}`);
	if ("queuedCount" in outcome && outcome.queuedCount !== void 0) fields.push(`laneQueued=${outcome.queuedCount}`);
	if ("error" in outcome) fields.push(`error=${outcome.error}`);
	return fields.join(" ");
}
//#endregion
//#region src/logging/diagnostic-session-recovery-coordinator.ts
const recoveryRequestsInFlight = /* @__PURE__ */ new Set();
function emitSessionRecoveryRequested(params) {
	emitDiagnosticEvent({
		type: "session.recovery.requested",
		sessionId: params.request.sessionId,
		sessionKey: params.request.sessionKey,
		state: "processing",
		stateGeneration: params.request.stateGeneration,
		ageMs: params.request.ageMs,
		queueDepth: params.request.queueDepth,
		reason: params.classification.reason,
		activeWorkKind: params.classification.activeWorkKind,
		allowActiveAbort: params.request.allowActiveAbort
	});
}
function emitSessionRecoveryCompleted(params) {
	emitDiagnosticEvent({
		type: "session.recovery.completed",
		sessionId: params.request.sessionId,
		sessionKey: params.request.sessionKey,
		state: "processing",
		stateGeneration: params.request.stateGeneration,
		ageMs: params.request.ageMs,
		queueDepth: params.request.queueDepth,
		activeWorkKind: params.outcome.activeWorkKind,
		status: params.outcome.status,
		action: params.outcome.action,
		outcomeReason: "reason" in params.outcome ? params.outcome.reason : void 0,
		released: recoveryOutcomeReleasedCount(params.outcome) || void 0,
		stale: params.stale
	});
}
function recoveryRequestKey(request) {
	const ref = request.sessionKey?.trim() || request.sessionId?.trim();
	if (!ref) return;
	return `${ref}:${request.stateGeneration ?? "unknown"}`;
}
function isRecoveryPromiseLike(value) {
	return typeof value?.then === "function";
}
function applyRecoveryOutcomeToDiagnosticState(params) {
	if (!params.outcome) return;
	if (!recoveryOutcomeMutatesSessionState(params.outcome)) {
		emitSessionRecoveryCompleted({
			request: params.request,
			outcome: params.outcome
		});
		return;
	}
	if (!isDiagnosticSessionStateCurrent({
		sessionId: params.request.sessionId,
		sessionKey: params.request.sessionKey,
		generation: params.request.stateGeneration,
		state: "processing"
	})) {
		emitSessionRecoveryCompleted({
			request: params.request,
			outcome: params.outcome,
			stale: true
		});
		return;
	}
	const state = getDiagnosticSessionState(params.request);
	const prevState = state.state;
	state.state = "idle";
	state.lastActivity = Date.now();
	state.generation = (state.generation ?? 0) + 1;
	state.lastStuckWarnAgeMs = void 0;
	state.lastLongRunningWarnAgeMs = void 0;
	state.queueDepth = recoveryOutcomeReleasedCount(params.outcome) > 0 ? 0 : Math.max(0, state.queueDepth - 1);
	emitDiagnosticEvent({
		type: "session.state",
		sessionId: state.sessionId,
		sessionKey: state.sessionKey,
		prevState,
		state: "idle",
		reason: `stuck_recovery:${params.outcome.status}`,
		queueDepth: state.queueDepth
	});
	emitSessionRecoveryCompleted({
		request: params.request,
		outcome: params.outcome
	});
	markDiagnosticActivity();
}
function requestStuckSessionRecovery(params) {
	const inFlightKey = recoveryRequestKey(params.request);
	if (inFlightKey && recoveryRequestsInFlight.has(inFlightKey)) {
		emitSessionRecoveryCompleted({
			request: params.request,
			outcome: {
				status: "skipped",
				action: "observe_only",
				reason: "already_in_flight",
				sessionId: params.request.sessionId,
				sessionKey: params.request.sessionKey,
				activeWorkKind: params.classification.activeWorkKind
			}
		});
		return;
	}
	if (inFlightKey) recoveryRequestsInFlight.add(inFlightKey);
	emitSessionRecoveryRequested({
		request: params.request,
		classification: params.classification
	});
	const clearInFlight = () => {
		if (inFlightKey) recoveryRequestsInFlight.delete(inFlightKey);
	};
	const failRecovery = (err) => {
		applyRecoveryOutcomeToDiagnosticState({
			request: params.request,
			outcome: {
				status: "failed",
				action: "none",
				reason: "exception",
				sessionId: params.request.sessionId,
				sessionKey: params.request.sessionKey,
				error: String(err)
			}
		});
	};
	try {
		const result = params.recover(params.request);
		if (isRecoveryPromiseLike(result)) {
			result.then((outcome) => {
				applyRecoveryOutcomeToDiagnosticState({
					request: params.request,
					outcome: outcome ?? void 0
				});
			}).catch(failRecovery).finally(clearInFlight);
			return;
		}
		applyRecoveryOutcomeToDiagnosticState({
			request: params.request,
			outcome: result ?? void 0
		});
		clearInFlight();
	} catch (err) {
		try {
			failRecovery(err);
		} finally {
			clearInFlight();
		}
	}
}
function resetDiagnosticSessionRecoveryCoordinatorForTest() {
	recoveryRequestsInFlight.clear();
}
//#endregion
//#region src/logging/diagnostic.ts
const webhookStats = {
	received: 0,
	processed: 0,
	errors: 0,
	lastReceived: 0
};
const DEFAULT_STUCK_SESSION_WARN_MS = 12e4;
const MIN_STUCK_SESSION_WARN_MS = 1e3;
const MAX_STUCK_SESSION_WARN_MS = 1440 * 60 * 1e3;
const MIN_STALLED_EMBEDDED_RUN_ABORT_MS = 10 * 6e4;
const STALLED_EMBEDDED_RUN_ABORT_WARN_MULTIPLIER = 5;
const RECENT_DIAGNOSTIC_ACTIVITY_MS = 12e4;
const DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS = 1e3;
const DEFAULT_LIVENESS_EVENT_LOOP_UTILIZATION_WARN = .95;
const DEFAULT_LIVENESS_CPU_CORE_RATIO_WARN = .9;
const DEFAULT_LIVENESS_WARN_COOLDOWN_MS = 12e4;
let commandPollBackoffRuntimePromise = null;
let stuckSessionRecoveryRuntimePromise = null;
let diagnosticLivenessMonitor = null;
let lastDiagnosticLivenessWallAt = 0;
let lastDiagnosticLivenessCpuUsage = null;
let lastDiagnosticLivenessEventLoopUtilization = null;
let lastDiagnosticLivenessEventAt = 0;
let lastDiagnosticLivenessWarnAt = 0;
function loadCommandPollBackoffRuntime() {
	commandPollBackoffRuntimePromise ??= import("./command-poll-backoff.runtime.js");
	return commandPollBackoffRuntimePromise;
}
async function recoverStuckSession(params) {
	stuckSessionRecoveryRuntimePromise ??= import("./diagnostic-stuck-session-recovery.runtime.js");
	return stuckSessionRecoveryRuntimePromise.then(({ recoverStuckDiagnosticSession }) => recoverStuckDiagnosticSession(params)).catch((err) => {
		diagnosticLogger.warn(`stuck session recovery unavailable: ${String(err)}`);
		return {
			status: "failed",
			action: "none",
			reason: "exception",
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			error: String(err)
		};
	});
}
function formatDiagnosticWorkLabel(state, now) {
	const label = state.sessionKey ?? state.sessionId ?? "unknown";
	const ageSeconds = Math.round(Math.max(0, now - state.lastActivity) / 1e3);
	const activity = getDiagnosticSessionActivitySnapshot({
		sessionId: state.sessionId,
		sessionKey: state.sessionKey
	}, now);
	const workKind = activity.activeWorkKind ? `/${activity.activeWorkKind}` : "";
	const lastProgress = activity.lastProgressReason ? ` last=${activity.lastProgressReason}` : "";
	return `${label}(${state.state}${workKind},q=${state.queueDepth},age=${ageSeconds}s${lastProgress})`;
}
function pushLimitedDiagnosticLabel(labels, label, limit = 5) {
	if (labels.length < limit) labels.push(label);
}
function getDiagnosticWorkSnapshot(now = Date.now()) {
	let activeCount = 0;
	let waitingCount = 0;
	let queuedCount = 0;
	const activeLabels = [];
	const waitingLabels = [];
	const queuedLabels = [];
	for (const state of diagnosticSessionStates.values()) {
		if (state.state === "processing") {
			activeCount += 1;
			pushLimitedDiagnosticLabel(activeLabels, formatDiagnosticWorkLabel(state, now));
		} else if (state.state === "waiting") {
			waitingCount += 1;
			pushLimitedDiagnosticLabel(waitingLabels, formatDiagnosticWorkLabel(state, now));
		}
		if (state.queueDepth > 0) pushLimitedDiagnosticLabel(queuedLabels, formatDiagnosticWorkLabel(state, now));
		queuedCount += state.queueDepth;
	}
	return {
		activeCount,
		waitingCount,
		queuedCount,
		activeLabels,
		waitingLabels,
		queuedLabels
	};
}
function hasOpenDiagnosticWork(snapshot) {
	return snapshot.activeCount > 0 || snapshot.waitingCount > 0 || snapshot.queuedCount > 0;
}
function hasRecentDiagnosticActivity(now) {
	const lastActivityAt = getLastDiagnosticActivityAt();
	return lastActivityAt > 0 && now - lastActivityAt <= RECENT_DIAGNOSTIC_ACTIVITY_MS;
}
function roundDiagnosticMetric(value, digits = 3) {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
function nanosecondsToMilliseconds(value) {
	return roundDiagnosticMetric(value / 1e6, 1);
}
function formatOptionalDiagnosticMetric(value) {
	return value === void 0 ? "unknown" : String(value);
}
function startDiagnosticLivenessSampler() {
	lastDiagnosticLivenessWallAt = Date.now();
	lastDiagnosticLivenessCpuUsage = process.cpuUsage();
	lastDiagnosticLivenessEventLoopUtilization = performance.eventLoopUtilization();
	lastDiagnosticLivenessEventAt = 0;
	lastDiagnosticLivenessWarnAt = 0;
	if (diagnosticLivenessMonitor) {
		diagnosticLivenessMonitor.reset();
		return;
	}
	try {
		diagnosticLivenessMonitor = monitorEventLoopDelay({ resolution: 20 });
		diagnosticLivenessMonitor.enable();
		diagnosticLivenessMonitor.reset();
	} catch (err) {
		diagnosticLivenessMonitor = null;
		diagnosticLogger.debug(`diagnostic liveness monitor unavailable: ${String(err)}`);
	}
}
function stopDiagnosticLivenessSampler() {
	diagnosticLivenessMonitor?.disable();
	diagnosticLivenessMonitor = null;
	lastDiagnosticLivenessWallAt = 0;
	lastDiagnosticLivenessCpuUsage = null;
	lastDiagnosticLivenessEventLoopUtilization = null;
	lastDiagnosticLivenessEventAt = 0;
	lastDiagnosticLivenessWarnAt = 0;
}
function sampleDiagnosticLiveness(now) {
	if (!diagnosticLivenessMonitor || !lastDiagnosticLivenessCpuUsage || !lastDiagnosticLivenessEventLoopUtilization || lastDiagnosticLivenessWallAt <= 0) {
		startDiagnosticLivenessSampler();
		return null;
	}
	const intervalMs = Math.max(1, now - lastDiagnosticLivenessWallAt);
	const cpuUsage = process.cpuUsage(lastDiagnosticLivenessCpuUsage);
	const currentEventLoopUtilization = performance.eventLoopUtilization();
	const eventLoopUtilization = performance.eventLoopUtilization(currentEventLoopUtilization, lastDiagnosticLivenessEventLoopUtilization).utilization;
	const eventLoopDelayP99Ms = nanosecondsToMilliseconds(diagnosticLivenessMonitor.percentile(99));
	const eventLoopDelayMaxMs = nanosecondsToMilliseconds(diagnosticLivenessMonitor.max);
	diagnosticLivenessMonitor.reset();
	lastDiagnosticLivenessWallAt = now;
	lastDiagnosticLivenessCpuUsage = process.cpuUsage();
	lastDiagnosticLivenessEventLoopUtilization = currentEventLoopUtilization;
	const cpuUserMs = roundDiagnosticMetric(cpuUsage.user / 1e3, 1);
	const cpuSystemMs = roundDiagnosticMetric(cpuUsage.system / 1e3, 1);
	const cpuTotalMs = roundDiagnosticMetric(cpuUserMs + cpuSystemMs, 1);
	const cpuCoreRatio = roundDiagnosticMetric(cpuTotalMs / intervalMs, 3);
	const eventLoopUtilizationRatio = roundDiagnosticMetric(eventLoopUtilization, 3);
	const reasons = [];
	if (eventLoopDelayP99Ms >= DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS || eventLoopDelayMaxMs >= DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS) reasons.push("event_loop_delay");
	if (eventLoopUtilizationRatio >= DEFAULT_LIVENESS_EVENT_LOOP_UTILIZATION_WARN) reasons.push("event_loop_utilization");
	if (cpuCoreRatio >= DEFAULT_LIVENESS_CPU_CORE_RATIO_WARN) reasons.push("cpu");
	if (reasons.length === 0) return null;
	return {
		reasons,
		intervalMs,
		eventLoopDelayP99Ms,
		eventLoopDelayMaxMs,
		eventLoopUtilization: eventLoopUtilizationRatio,
		cpuUserMs,
		cpuSystemMs,
		cpuTotalMs,
		cpuCoreRatio
	};
}
function shouldEmitDiagnosticLivenessEvent(now) {
	if (lastDiagnosticLivenessEventAt > 0 && now - lastDiagnosticLivenessEventAt < DEFAULT_LIVENESS_WARN_COOLDOWN_MS) return false;
	lastDiagnosticLivenessEventAt = now;
	return true;
}
function shouldEmitDiagnosticLivenessWarning(now, work) {
	if (!hasOpenDiagnosticWork(work)) return false;
	if (lastDiagnosticLivenessWarnAt > 0 && now - lastDiagnosticLivenessWarnAt < DEFAULT_LIVENESS_WARN_COOLDOWN_MS) return false;
	lastDiagnosticLivenessWarnAt = now;
	return true;
}
function emitDiagnosticLivenessWarning(sample, work) {
	const phase = getCurrentDiagnosticPhase();
	const recentPhases = getRecentDiagnosticPhases(6);
	const recentPhaseSummary = formatRecentDiagnosticPhases(recentPhases);
	const workLabelSummary = formatDiagnosticWorkLabels(work);
	const message = `liveness warning: reasons=${sample.reasons.join(",")} interval=${Math.round(sample.intervalMs / 1e3)}s eventLoopDelayP99Ms=${formatOptionalDiagnosticMetric(sample.eventLoopDelayP99Ms)} eventLoopDelayMaxMs=${formatOptionalDiagnosticMetric(sample.eventLoopDelayMaxMs)} eventLoopUtilization=${formatOptionalDiagnosticMetric(sample.eventLoopUtilization)} cpuCoreRatio=${formatOptionalDiagnosticMetric(sample.cpuCoreRatio)} active=${work.activeCount} waiting=${work.waitingCount} queued=${work.queuedCount}${phase ? ` phase=${phase}` : ""}${recentPhaseSummary ? ` recentPhases=${recentPhaseSummary}` : ""}${workLabelSummary ? ` work=[${workLabelSummary}]` : ""}`;
	const hasBlockingWork = work.waitingCount > 0 || work.queuedCount > 0;
	const hasSustainedEventLoopDelay = (sample.eventLoopDelayP99Ms ?? 0) >= DEFAULT_LIVENESS_EVENT_LOOP_DELAY_WARN_MS;
	if (hasBlockingWork || hasOpenDiagnosticWork(work) && hasSustainedEventLoopDelay) diagnosticLogger.warn(message);
	else diagnosticLogger.debug(message);
	emitDiagnosticEvent({
		type: "diagnostic.liveness.warning",
		reasons: sample.reasons,
		intervalMs: sample.intervalMs,
		eventLoopDelayP99Ms: sample.eventLoopDelayP99Ms,
		eventLoopDelayMaxMs: sample.eventLoopDelayMaxMs,
		eventLoopUtilization: sample.eventLoopUtilization,
		cpuUserMs: sample.cpuUserMs,
		cpuSystemMs: sample.cpuSystemMs,
		cpuTotalMs: sample.cpuTotalMs,
		cpuCoreRatio: sample.cpuCoreRatio,
		active: work.activeCount,
		waiting: work.waitingCount,
		queued: work.queuedCount,
		phase,
		recentPhases,
		activeWorkLabels: work.activeLabels,
		waitingWorkLabels: work.waitingLabels,
		queuedWorkLabels: work.queuedLabels
	});
	markDiagnosticActivity();
}
function formatRecentDiagnosticPhases(phases) {
	return phases.map((phase) => `${phase.name}:${Math.round(phase.durationMs ?? 0)}ms`).join(",");
}
function formatDiagnosticWorkLabels(work) {
	return [
		work.activeLabels.length > 0 ? `active=${work.activeLabels.join("|")}` : "",
		work.waitingLabels.length > 0 ? `waiting=${work.waitingLabels.join("|")}` : "",
		work.queuedLabels.length > 0 ? `queued=${work.queuedLabels.join("|")}` : ""
	].filter(Boolean).join(" ");
}
function resolveStuckSessionWarnMs(config) {
	const raw = config?.diagnostics?.stuckSessionWarnMs;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_STUCK_SESSION_WARN_MS;
	const rounded = Math.floor(raw);
	if (rounded < MIN_STUCK_SESSION_WARN_MS || rounded > MAX_STUCK_SESSION_WARN_MS) return DEFAULT_STUCK_SESSION_WARN_MS;
	return rounded;
}
function resolveStuckSessionAbortMs(config, stuckSessionWarnMs) {
	const raw = config?.diagnostics?.stuckSessionAbortMs;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return resolveStalledEmbeddedRunAbortMs(stuckSessionWarnMs);
	const rounded = Math.floor(raw);
	if (rounded <= 0) return resolveStalledEmbeddedRunAbortMs(stuckSessionWarnMs);
	return Math.max(stuckSessionWarnMs, rounded);
}
function resolveStalledEmbeddedRunAbortMs(stuckSessionWarnMs) {
	return Math.max(MIN_STALLED_EMBEDDED_RUN_ABORT_MS, stuckSessionWarnMs * STALLED_EMBEDDED_RUN_ABORT_WARN_MULTIPLIER);
}
function isStalledEmbeddedRunRecoveryEligible(params) {
	return params.classification?.eventType === "session.stalled" && params.classification.classification === "stalled_agent_run" && params.classification.activeWorkKind === "embedded_run" && params.ageMs >= params.stuckSessionAbortMs;
}
function logWebhookReceived(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	webhookStats.received += 1;
	webhookStats.lastReceived = Date.now();
	if (diagnosticLogger.isEnabled("debug")) diagnosticLogger.debug(`webhook received: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${params.chatId ?? "unknown"} total=${webhookStats.received}`);
	emitDiagnosticEvent({
		type: "webhook.received",
		channel: params.channel,
		updateType: params.updateType,
		chatId: params.chatId
	});
	markDiagnosticActivity();
}
function logWebhookProcessed(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	webhookStats.processed += 1;
	if (diagnosticLogger.isEnabled("debug")) diagnosticLogger.debug(`webhook processed: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${params.chatId ?? "unknown"} duration=${params.durationMs ?? 0}ms processed=${webhookStats.processed}`);
	emitDiagnosticEvent({
		type: "webhook.processed",
		channel: params.channel,
		updateType: params.updateType,
		chatId: params.chatId,
		durationMs: params.durationMs
	});
	markDiagnosticActivity();
}
function logWebhookError(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	webhookStats.errors += 1;
	diagnosticLogger.error(`webhook error: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${params.chatId ?? "unknown"} error="${params.error}" errors=${webhookStats.errors}`);
	emitDiagnosticEvent({
		type: "webhook.error",
		channel: params.channel,
		updateType: params.updateType,
		chatId: params.chatId,
		error: params.error
	});
	markDiagnosticActivity();
}
function logMessageQueued(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	const state = getDiagnosticSessionState(params);
	state.queueDepth += 1;
	state.lastActivity = Date.now();
	state.generation = (state.generation ?? 0) + 1;
	state.lastStuckWarnAgeMs = void 0;
	state.lastLongRunningWarnAgeMs = void 0;
	if (diagnosticLogger.isEnabled("debug")) diagnosticLogger.debug(`message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${state.sessionKey ?? "unknown"} source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`);
	emitDiagnosticEvent({
		type: "message.queued",
		sessionId: state.sessionId,
		sessionKey: state.sessionKey,
		channel: params.channel,
		source: params.source,
		queueDepth: state.queueDepth
	});
	markDiagnosticActivity();
}
function logMessageProcessed(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	if (params.outcome === "error" ? diagnosticLogger.isEnabled("error") : diagnosticLogger.isEnabled("debug")) {
		const payload = `message processed: channel=${params.channel} chatId=${params.chatId ?? "unknown"} messageId=${params.messageId ?? "unknown"} sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} duration=${params.durationMs ?? 0}ms${params.reason ? ` reason=${params.reason}` : ""}${params.error ? ` error="${params.error}"` : ""}`;
		if (params.outcome === "error") diagnosticLogger.error(payload);
		else diagnosticLogger.debug(payload);
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
	markDiagnosticActivity();
}
function logSessionStateChange(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	const state = getDiagnosticSessionState(params);
	const isProbeSession = state.sessionId?.startsWith("probe-") ?? false;
	const prevState = state.state;
	state.state = params.state;
	state.lastActivity = Date.now();
	state.generation = (state.generation ?? 0) + 1;
	state.lastStuckWarnAgeMs = void 0;
	state.lastLongRunningWarnAgeMs = void 0;
	if (params.state === "idle") state.queueDepth = Math.max(0, state.queueDepth - 1);
	if (!isProbeSession && diagnosticLogger.isEnabled("debug")) diagnosticLogger.debug(`session state: sessionId=${state.sessionId ?? "unknown"} sessionKey=${state.sessionKey ?? "unknown"} prev=${prevState} new=${params.state} reason="${params.reason ?? ""}" queueDepth=${state.queueDepth}`);
	emitDiagnosticEvent({
		type: "session.state",
		sessionId: state.sessionId,
		sessionKey: state.sessionKey,
		prevState,
		state: params.state,
		reason: params.reason,
		queueDepth: state.queueDepth
	});
	markDiagnosticActivity();
}
function markDiagnosticSessionProgress(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	const state = getDiagnosticSessionState(params);
	state.lastActivity = Date.now();
	state.generation = (state.generation ?? 0) + 1;
	state.lastStuckWarnAgeMs = void 0;
	state.lastLongRunningWarnAgeMs = void 0;
	markDiagnosticActivity();
}
function sessionAttentionFields(params) {
	const terminalProgressStale = isTerminalDiagnosticProgressReason(params.activity.lastProgressReason);
	return {
		...params.classification.activeWorkKind ? { activeWorkKind: params.classification.activeWorkKind } : {},
		...params.activity.lastProgressAgeMs !== void 0 ? { lastProgressAgeMs: params.activity.lastProgressAgeMs } : {},
		...params.activity.lastProgressReason ? { lastProgressReason: params.activity.lastProgressReason } : {},
		...params.activity.activeToolName ? { activeToolName: params.activity.activeToolName } : {},
		...params.activity.activeToolCallId ? { activeToolCallId: params.activity.activeToolCallId } : {},
		...params.activity.activeToolAgeMs !== void 0 ? { activeToolAgeMs: params.activity.activeToolAgeMs } : {},
		...terminalProgressStale ? { terminalProgressStale: true } : {}
	};
}
function isTerminalDiagnosticProgressReason(reason) {
	if (!reason) return false;
	return reason === "run:completed" || reason === "embedded_run:ended" || reason.includes("response.completed") || reason.includes("rawResponseItem/completed") || reason.includes("raw_response_item.completed") || reason.includes("output_item.done");
}
function formatSessionActivityLogFields(activity) {
	const fields = [];
	if (activity.lastProgressReason) fields.push(`lastProgress=${activity.lastProgressReason}`);
	if (activity.lastProgressAgeMs !== void 0) fields.push(`lastProgressAge=${Math.round(activity.lastProgressAgeMs / 1e3)}s`);
	if (activity.activeToolName) fields.push(`activeTool=${activity.activeToolName}`);
	if (activity.activeToolCallId) fields.push(`activeToolCallId=${activity.activeToolCallId}`);
	if (activity.activeToolAgeMs !== void 0) fields.push(`activeToolAge=${Math.round(activity.activeToolAgeMs / 1e3)}s`);
	if (isTerminalDiagnosticProgressReason(activity.lastProgressReason)) fields.push("terminalProgressStale=true");
	return fields.join(" ");
}
function logSessionAttention(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	const state = getDiagnosticSessionState(params);
	const activity = getDiagnosticSessionActivitySnapshot({
		sessionId: state.sessionId,
		sessionKey: state.sessionKey
	}, Date.now());
	const classification = classifySessionAttention({
		queueDepth: state.queueDepth,
		activity,
		staleMs: params.thresholdMs
	});
	const recoveryEligible = classification.recoveryEligible || isStalledEmbeddedRunRecoveryEligible({
		classification,
		ageMs: params.ageMs,
		stuckSessionAbortMs: params.abortThresholdMs ?? resolveStalledEmbeddedRunAbortMs(params.thresholdMs)
	});
	if (classification.eventType === "session.stuck") {
		const nextWarnAgeMs = state.lastStuckWarnAgeMs === void 0 ? params.thresholdMs : Math.max(state.lastStuckWarnAgeMs + params.thresholdMs, state.lastStuckWarnAgeMs * 2);
		if (params.ageMs < nextWarnAgeMs) return;
		state.lastStuckWarnAgeMs = params.ageMs;
	}
	if (classification.eventType === "session.long_running") {
		const nextWarnAgeMs = state.lastLongRunningWarnAgeMs === void 0 ? params.thresholdMs : Math.max(state.lastLongRunningWarnAgeMs + params.thresholdMs, state.lastLongRunningWarnAgeMs * 2);
		if (params.ageMs < nextWarnAgeMs) return;
		state.lastLongRunningWarnAgeMs = params.ageMs;
	}
	const label = classification.eventType === "session.stuck" ? "stuck session" : classification.eventType === "session.stalled" ? "stalled session" : "long-running session";
	const detailFields = [formatSessionActivityLogFields(activity), formatCronSessionDiagnosticFields(resolveCronSessionDiagnosticContext({ sessionKey: state.sessionKey }))].filter(Boolean).join(" ");
	const message = `${label}: sessionId=${state.sessionId ?? "unknown"} sessionKey=${state.sessionKey ?? "unknown"} state=${params.state} age=${Math.round(params.ageMs / 1e3)}s queueDepth=${state.queueDepth} reason=${classification.reason} classification=${classification.classification}${classification.activeWorkKind ? ` activeWorkKind=${classification.activeWorkKind}` : ""}${detailFields ? ` ${detailFields}` : ""} recovery=${recoveryEligible ? "checking" : "none"}`;
	if (classification.eventType === "session.long_running" && state.queueDepth <= 0) diagnosticLogger.debug(message);
	else diagnosticLogger.warn(message);
	const baseEvent = {
		sessionId: state.sessionId,
		sessionKey: state.sessionKey,
		state: params.state,
		ageMs: params.ageMs,
		queueDepth: state.queueDepth,
		reason: classification.reason,
		...sessionAttentionFields({
			classification,
			activity
		})
	};
	if (classification.eventType === "session.long_running") emitDiagnosticEvent({
		type: "session.long_running",
		...baseEvent,
		classification: "long_running"
	});
	else if (classification.eventType === "session.stalled") emitDiagnosticEvent({
		type: "session.stalled",
		...baseEvent,
		classification: classification.classification
	});
	else emitDiagnosticEvent({
		type: "session.stuck",
		...baseEvent,
		classification: "stale_session_state"
	});
	markDiagnosticActivity();
	return classification;
}
function logRunAttempt(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	diagnosticLogger.debug(`run attempt: sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} runId=${params.runId} attempt=${params.attempt}`);
	emitDiagnosticEvent({
		type: "run.attempt",
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		runId: params.runId,
		attempt: params.attempt
	});
	markDiagnosticActivity();
}
function logToolLoopAction(params) {
	if (!areDiagnosticsEnabledForProcess()) return;
	const payload = `tool loop: sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} tool=${params.toolName} level=${params.level} action=${params.action} detector=${params.detector} count=${params.count}${params.pairedToolName ? ` pairedTool=${params.pairedToolName}` : ""} message="${params.message}"`;
	if (params.level === "critical") diagnosticLogger.error(payload);
	else diagnosticLogger.warn(payload);
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
	markDiagnosticActivity();
}
function logActiveRuns() {
	if (!areDiagnosticsEnabledForProcess()) return;
	const now = Date.now();
	const activeSessions = Array.from(diagnosticSessionStates.entries()).filter(([, s]) => s.state === "processing").map(([id, s]) => `${id}(q=${s.queueDepth},age=${Math.round((now - s.lastActivity) / 1e3)}s)`);
	diagnosticLogger.debug(`active runs: count=${activeSessions.length} sessions=[${activeSessions.join(", ")}]`);
	markDiagnosticActivity();
}
let heartbeatInterval = null;
function startDiagnosticHeartbeat(config, opts) {
	if (!areDiagnosticsEnabledForProcess() || !isDiagnosticsEnabled(config)) return;
	startDiagnosticStabilityRecorder();
	installDiagnosticStabilityFatalHook();
	if (heartbeatInterval) return;
	startDiagnosticLivenessSampler();
	const livenessGraceUntil = opts?.startupGraceMs != null && opts.startupGraceMs > 0 ? Date.now() + opts.startupGraceMs : 0;
	heartbeatInterval = setInterval(() => {
		let heartbeatConfig = config;
		if (!heartbeatConfig) try {
			heartbeatConfig = (opts?.getConfig ?? getRuntimeConfig)();
		} catch {
			heartbeatConfig = void 0;
		}
		const stuckSessionWarnMs = resolveStuckSessionWarnMs(heartbeatConfig);
		const stuckSessionAbortMs = resolveStuckSessionAbortMs(heartbeatConfig, stuckSessionWarnMs);
		const now = Date.now();
		pruneDiagnosticSessionStates(now, true);
		const work = getDiagnosticWorkSnapshot(now);
		const inStartupGrace = livenessGraceUntil > 0 && now < livenessGraceUntil;
		const rawLivenessSample = (opts?.sampleLiveness ?? sampleDiagnosticLiveness)(now, work);
		const livenessSample = inStartupGrace ? null : rawLivenessSample;
		const shouldEmitLivenessEvent = livenessSample !== null && shouldEmitDiagnosticLivenessEvent(now);
		const shouldEmitLivenessWarning = livenessSample !== null && shouldEmitDiagnosticLivenessWarning(now, work);
		const shouldEmitLivenessReport = shouldEmitLivenessEvent || shouldEmitLivenessWarning;
		const shouldRecordMemorySample = shouldEmitLivenessReport || hasRecentDiagnosticActivity(now) || hasOpenDiagnosticWork(work);
		(opts?.emitMemorySample ?? emitDiagnosticMemorySample)({ emitSample: shouldRecordMemorySample });
		if (!shouldRecordMemorySample) return;
		if (shouldEmitLivenessReport && livenessSample) emitDiagnosticLivenessWarning(livenessSample, work);
		diagnosticLogger.debug(`heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${work.activeCount} waiting=${work.waitingCount} queued=${work.queuedCount}`);
		emitDiagnosticEvent({
			type: "diagnostic.heartbeat",
			webhooks: {
				received: webhookStats.received,
				processed: webhookStats.processed,
				errors: webhookStats.errors
			},
			active: work.activeCount,
			waiting: work.waitingCount,
			queued: work.queuedCount
		});
		loadCommandPollBackoffRuntime().then(({ pruneStaleCommandPolls }) => {
			for (const [, state] of diagnosticSessionStates) pruneStaleCommandPolls(state);
		}).catch((err) => {
			diagnosticLogger.debug(`command-poll-backoff prune failed: ${String(err)}`);
		});
		for (const [, state] of diagnosticSessionStates) {
			const ageMs = now - state.lastActivity;
			if (state.state === "processing" && ageMs > stuckSessionWarnMs) {
				const classification = logSessionAttention({
					sessionId: state.sessionId,
					sessionKey: state.sessionKey,
					state: state.state,
					ageMs,
					thresholdMs: stuckSessionWarnMs,
					abortThresholdMs: stuckSessionAbortMs
				});
				if (classification?.recoveryEligible) requestStuckSessionRecovery({
					recover: opts?.recoverStuckSession ?? recoverStuckSession,
					classification,
					request: {
						sessionId: state.sessionId,
						sessionKey: state.sessionKey,
						ageMs,
						queueDepth: state.queueDepth,
						stateGeneration: state.generation
					}
				});
				else if (classification && isStalledEmbeddedRunRecoveryEligible({
					classification,
					ageMs,
					stuckSessionAbortMs
				})) requestStuckSessionRecovery({
					recover: opts?.recoverStuckSession ?? recoverStuckSession,
					classification,
					request: {
						sessionId: state.sessionId,
						sessionKey: state.sessionKey,
						ageMs,
						queueDepth: state.queueDepth,
						allowActiveAbort: true,
						stateGeneration: state.generation
					}
				});
			}
		}
	}, 3e4);
	heartbeatInterval.unref?.();
}
function stopDiagnosticHeartbeat() {
	if (heartbeatInterval) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
	}
	stopDiagnosticLivenessSampler();
	stopDiagnosticStabilityRecorder();
	uninstallDiagnosticStabilityFatalHook();
}
function getDiagnosticSessionStateCountForTest() {
	return getDiagnosticSessionStateCountForTest$1();
}
function resetDiagnosticStateForTest() {
	resetDiagnosticSessionRecoveryCoordinatorForTest();
	resetDiagnosticSessionStateForTest();
	resetDiagnosticActivityForTest();
	resetDiagnosticRunActivityForTest();
	webhookStats.received = 0;
	webhookStats.processed = 0;
	webhookStats.errors = 0;
	webhookStats.lastReceived = 0;
	stopDiagnosticHeartbeat();
	resetDiagnosticMemoryForTest();
	resetDiagnosticPhasesForTest();
	resetDiagnosticStabilityRecorderForTest();
	resetDiagnosticStabilityBundleForTest();
}
//#endregion
export { markDiagnosticEmbeddedRunStarted as S, stopDiagnosticHeartbeat as _, logRunAttempt as a, resolveCronSessionDiagnosticContext as b, logToolLoopAction as c, logWebhookReceived as d, markDiagnosticSessionProgress as f, startDiagnosticHeartbeat as g, resolveStuckSessionWarnMs as h, logMessageQueued as i, logWebhookError as l, resolveStuckSessionAbortMs as m, logActiveRuns as n, logSessionAttention as o, resetDiagnosticStateForTest as p, logMessageProcessed as r, logSessionStateChange as s, getDiagnosticSessionStateCountForTest as t, logWebhookProcessed as u, formatRecoveryOutcome as v, markDiagnosticEmbeddedRunEnded as x, formatStoppedCronSessionDiagnosticFields as y };
