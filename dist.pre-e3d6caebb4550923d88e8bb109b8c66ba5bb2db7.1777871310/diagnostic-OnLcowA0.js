import { i as isDiagnosticsEnabled, n as emitDiagnosticEvent, o as onInternalDiagnosticEvent, t as areDiagnosticsEnabledForProcess } from "./diagnostic-events-DrCvmHmj.js";
import { i as getRuntimeConfig } from "./io-BD1XQ5lD.js";
import "./config-CshcuIUd.js";
import { t as getDiagnosticContinuationQueueMetrics } from "./diagnostic-continuation-queues-BnCI2LZf.js";
import { a as markDiagnosticActivity, n as getLastDiagnosticActivityAt, o as resetDiagnosticActivityForTest, t as diagnosticLogger } from "./diagnostic-runtime-D46_liQE.js";
import { a as resetDiagnosticSessionStateForTest, i as pruneDiagnosticSessionStates, n as getDiagnosticSessionState, r as getDiagnosticSessionStateCountForTest$1, t as diagnosticSessionStates } from "./diagnostic-session-state-Dq0ZJI3F.js";
import { i as resetDiagnosticStabilityRecorderForTest, o as startDiagnosticStabilityRecorder, s as stopDiagnosticStabilityRecorder } from "./diagnostic-stability-5kGdlBIK.js";
import { a as installDiagnosticStabilityFatalHook, d as uninstallDiagnosticStabilityFatalHook, l as resetDiagnosticStabilityBundleForTest } from "./diagnostic-stability-bundle-BbW2Y47g.js";
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
function resolveSessionActivity(params) {
	if (params.runId) {
		const byRun = activityByRunId.get(params.runId);
		if (byRun) return byRun;
	}
	for (const ref of sessionRefs(params)) {
		const activity = activityByRef.get(ref);
		if (activity) {
			if (params.runId) activityByRunId.set(params.runId, activity);
			return activity;
		}
	}
	if (!params.create) return;
	const activity = {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		activeEmbeddedRun: false,
		activeTools: /* @__PURE__ */ new Map(),
		activeModelCalls: /* @__PURE__ */ new Set(),
		lastProgressAt: Date.now()
	};
	for (const ref of sessionRefs(params)) activityByRef.set(ref, activity);
	if (params.runId) activityByRunId.set(params.runId, activity);
	return activity;
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
function recoverStuckSession(params) {
	stuckSessionRecoveryRuntimePromise ??= import("./diagnostic-stuck-session-recovery.runtime.js");
	stuckSessionRecoveryRuntimePromise.then(({ recoverStuckDiagnosticSession }) => recoverStuckDiagnosticSession(params)).catch((err) => {
		diagnosticLogger.warn(`stuck session recovery unavailable: ${String(err)}`);
	});
}
function getDiagnosticWorkSnapshot() {
	let activeCount = 0;
	let waitingCount = 0;
	let queuedCount = 0;
	for (const state of diagnosticSessionStates.values()) {
		if (state.state === "processing") activeCount += 1;
		else if (state.state === "waiting") waitingCount += 1;
		queuedCount += state.queueDepth;
	}
	return {
		activeCount,
		waitingCount,
		queuedCount
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
function shouldEmitDiagnosticLivenessWarning(now, work, continuationQueue) {
	if (!hasOpenDiagnosticWork(work) && !hasContinuationQueueActivity(continuationQueue)) return false;
	if (lastDiagnosticLivenessWarnAt > 0 && now - lastDiagnosticLivenessWarnAt < DEFAULT_LIVENESS_WARN_COOLDOWN_MS) return false;
	lastDiagnosticLivenessWarnAt = now;
	return true;
}
function formatContinuationQueueNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}
function hasContinuationQueueActivity(continuationQueue) {
	return continuationQueue !== void 0 && (continuationQueue.totalQueued > 0 || continuationQueue.enqueuedSinceLastSample > 0 || continuationQueue.drainedSinceLastSample > 0 || continuationQueue.failedSinceLastSample > 0);
}
function safeGetDiagnosticContinuationQueueMetrics(now) {
	try {
		return getDiagnosticContinuationQueueMetrics(now);
	} catch (err) {
		diagnosticLogger.debug(`continuation queue diagnostics failed: ${String(err)}`);
		return;
	}
}
function formatContinuationQueueTopQueues(continuationQueue) {
	return continuationQueue.topQueues.map((queue) => `${queue.sessionKey}(total=${queue.totalQueued},runnable=${queue.pendingRunnable},scheduled=${queue.pendingScheduled},staged=${queue.stagedPostCompaction},invalid=${queue.invalidQueued})`).join(",");
}
function formatContinuationQueueHistory(continuationQueue) {
	return JSON.stringify(continuationQueue.queueDepthHistory.map((point) => ({
		sampled_at: point.sampledAt,
		total_queued: point.totalQueued,
		runnable: point.pendingRunnable,
		scheduled: point.pendingScheduled,
		staged_post_compaction: point.stagedPostCompaction,
		invalid_queued: point.invalidQueued,
		enqueued: point.enqueued,
		drained: point.drained,
		failed: point.failed
	})));
}
function formatContinuationQueueLogSuffix(continuationQueue) {
	if (!hasContinuationQueueActivity(continuationQueue)) return "";
	return ` continuationQueueTotal=${continuationQueue.totalQueued} continuationQueueRunnable=${continuationQueue.pendingRunnable} continuationQueueScheduled=${continuationQueue.pendingScheduled} continuationQueueStagedPostCompaction=${continuationQueue.stagedPostCompaction} continuationQueueInvalid=${continuationQueue.invalidQueued} continuationQueueEnqueued=${continuationQueue.enqueuedSinceLastSample} continuationQueueDrained=${continuationQueue.drainedSinceLastSample} continuationQueueFailed=${continuationQueue.failedSinceLastSample} continuationQueueEnqueueRatePerMinute=${formatContinuationQueueNumber(continuationQueue.enqueueRatePerMinute)} continuationQueueDrainRatePerMinute=${formatContinuationQueueNumber(continuationQueue.drainRatePerMinute)} continuationQueueFailedRatePerMinute=${formatContinuationQueueNumber(continuationQueue.failedRatePerMinute)} continuationQueueTop=[${formatContinuationQueueTopQueues(continuationQueue)}] queue_depth_history=${formatContinuationQueueHistory(continuationQueue)}`;
}
function emitDiagnosticContinuationQueueSample(continuationQueue) {
	emitDiagnosticEvent({
		type: "diagnostic.continuation_queue.sample",
		continuationQueue
	});
	markDiagnosticActivity();
}
function emitDiagnosticLivenessWarning(sample, work, continuationQueue) {
	const message = `liveness warning: reasons=${sample.reasons.join(",")} interval=${Math.round(sample.intervalMs / 1e3)}s eventLoopDelayP99Ms=${formatOptionalDiagnosticMetric(sample.eventLoopDelayP99Ms)} eventLoopDelayMaxMs=${formatOptionalDiagnosticMetric(sample.eventLoopDelayMaxMs)} eventLoopUtilization=${formatOptionalDiagnosticMetric(sample.eventLoopUtilization)} cpuCoreRatio=${formatOptionalDiagnosticMetric(sample.cpuCoreRatio)} active=${work.activeCount} waiting=${work.waitingCount} queued=${work.queuedCount}${formatContinuationQueueLogSuffix(continuationQueue)}`;
	if (hasOpenDiagnosticWork(work) || hasContinuationQueueActivity(continuationQueue)) diagnosticLogger.warn(message);
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
		...hasContinuationQueueActivity(continuationQueue) ? { continuationQueue } : {}
	});
	markDiagnosticActivity();
}
function resolveStuckSessionWarnMs(config) {
	const raw = config?.diagnostics?.stuckSessionWarnMs;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_STUCK_SESSION_WARN_MS;
	const rounded = Math.floor(raw);
	if (rounded < MIN_STUCK_SESSION_WARN_MS || rounded > MAX_STUCK_SESSION_WARN_MS) return DEFAULT_STUCK_SESSION_WARN_MS;
	return rounded;
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
	state.lastStuckWarnAgeMs = void 0;
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
	state.lastStuckWarnAgeMs = void 0;
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
	state.lastStuckWarnAgeMs = void 0;
	markDiagnosticActivity();
}
function sessionAttentionFields(params) {
	return {
		...params.classification.activeWorkKind ? { activeWorkKind: params.classification.activeWorkKind } : {},
		...params.activity.lastProgressAgeMs !== void 0 ? { lastProgressAgeMs: params.activity.lastProgressAgeMs } : {},
		...params.activity.lastProgressReason ? { lastProgressReason: params.activity.lastProgressReason } : {},
		...params.activity.activeToolName ? { activeToolName: params.activity.activeToolName } : {},
		...params.activity.activeToolCallId ? { activeToolCallId: params.activity.activeToolCallId } : {},
		...params.activity.activeToolAgeMs !== void 0 ? { activeToolAgeMs: params.activity.activeToolAgeMs } : {}
	};
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
	if (classification.eventType === "session.stuck") {
		const nextWarnAgeMs = state.lastStuckWarnAgeMs === void 0 ? params.thresholdMs : Math.max(state.lastStuckWarnAgeMs + params.thresholdMs, state.lastStuckWarnAgeMs * 2);
		if (params.ageMs < nextWarnAgeMs) return;
		state.lastStuckWarnAgeMs = params.ageMs;
	}
	const label = classification.eventType === "session.stuck" ? "stuck session" : classification.eventType === "session.stalled" ? "stalled session" : "long-running session";
	diagnosticLogger.warn(`${label}: sessionId=${state.sessionId ?? "unknown"} sessionKey=${state.sessionKey ?? "unknown"} state=${params.state} age=${Math.round(params.ageMs / 1e3)}s queueDepth=${state.queueDepth} reason=${classification.reason} classification=${classification.classification}${classification.activeWorkKind ? ` activeWorkKind=${classification.activeWorkKind}` : ""} recovery=${classification.recoveryEligible ? "checking" : "none"}`);
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
	heartbeatInterval = setInterval(() => {
		let heartbeatConfig = config;
		if (!heartbeatConfig) try {
			heartbeatConfig = (opts?.getConfig ?? getRuntimeConfig)();
		} catch {
			heartbeatConfig = void 0;
		}
		const stuckSessionWarnMs = resolveStuckSessionWarnMs(heartbeatConfig);
		const now = Date.now();
		pruneDiagnosticSessionStates(now, true);
		const work = getDiagnosticWorkSnapshot();
		const continuationQueue = safeGetDiagnosticContinuationQueueMetrics(now);
		const livenessSample = (opts?.sampleLiveness ?? sampleDiagnosticLiveness)(now, work);
		const shouldEmitLivenessEvent = livenessSample !== null && shouldEmitDiagnosticLivenessEvent(now);
		const shouldEmitLivenessWarning = livenessSample !== null && shouldEmitDiagnosticLivenessWarning(now, work, continuationQueue);
		const hasContinuationActivity = hasContinuationQueueActivity(continuationQueue);
		const shouldEmitLivenessReport = shouldEmitLivenessEvent || shouldEmitLivenessWarning;
		const shouldRecordMemorySample = shouldEmitLivenessReport || hasRecentDiagnosticActivity(now) || hasOpenDiagnosticWork(work) || hasContinuationActivity;
		(opts?.emitMemorySample ?? emitDiagnosticMemorySample)({ emitSample: shouldRecordMemorySample });
		if (!shouldRecordMemorySample) return;
		if (shouldEmitLivenessReport && livenessSample) emitDiagnosticLivenessWarning(livenessSample, work, continuationQueue);
		if (hasContinuationActivity) emitDiagnosticContinuationQueueSample(continuationQueue);
		diagnosticLogger.debug(`heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${work.activeCount} waiting=${work.waitingCount} queued=${work.queuedCount}${formatContinuationQueueLogSuffix(continuationQueue)}`);
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
				if (logSessionAttention({
					sessionId: state.sessionId,
					sessionKey: state.sessionKey,
					state: state.state,
					ageMs,
					thresholdMs: stuckSessionWarnMs
				})?.recoveryEligible) (opts?.recoverStuckSession ?? recoverStuckSession)({
					sessionId: state.sessionId,
					sessionKey: state.sessionKey,
					ageMs,
					queueDepth: state.queueDepth
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
	resetDiagnosticSessionStateForTest();
	resetDiagnosticActivityForTest();
	resetDiagnosticRunActivityForTest();
	webhookStats.received = 0;
	webhookStats.processed = 0;
	webhookStats.errors = 0;
	webhookStats.lastReceived = 0;
	stopDiagnosticHeartbeat();
	resetDiagnosticMemoryForTest();
	resetDiagnosticStabilityRecorderForTest();
	resetDiagnosticStabilityBundleForTest();
}
//#endregion
export { markDiagnosticEmbeddedRunEnded as _, logRunAttempt as a, logToolLoopAction as c, logWebhookReceived as d, markDiagnosticSessionProgress as f, stopDiagnosticHeartbeat as g, startDiagnosticHeartbeat as h, logMessageQueued as i, logWebhookError as l, resolveStuckSessionWarnMs as m, logActiveRuns as n, logSessionAttention as o, resetDiagnosticStateForTest as p, logMessageProcessed as r, logSessionStateChange as s, getDiagnosticSessionStateCountForTest as t, logWebhookProcessed as u, markDiagnosticEmbeddedRunStarted as v };
