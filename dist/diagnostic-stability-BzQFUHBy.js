import { s as onDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
//#region src/logging/diagnostic-stability.ts
const DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY = 1e3;
const DEFAULT_DIAGNOSTIC_STABILITY_LIMIT = 50;
const MAX_DIAGNOSTIC_STABILITY_LIMIT = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY;
const LIVENESS_EVENT_LOOP_DELAY_WARN_MS = 1e3;
const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;
function createState(capacity = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY) {
	return {
		records: Array.from({ length: capacity }),
		capacity,
		nextIndex: 0,
		count: 0,
		dropped: 0,
		unsubscribe: null
	};
}
function getDiagnosticStabilityState() {
	const globalStore = globalThis;
	globalStore["__openclawDiagnosticStabilityState"] ??= createState();
	return globalStore["__openclawDiagnosticStabilityState"];
}
function copyMemory(memory) {
	return { ...memory };
}
function copyReasonCode(reason) {
	if (!reason || !SAFE_REASON_CODE.test(reason)) return;
	return reason;
}
function assignReasonCode(record, reason) {
	const reasonCode = copyReasonCode(reason);
	if (reasonCode) record.reason = reasonCode;
}
function resolveDiagnosticLivenessRecordLevel(event) {
	const hasBlockingWork = event.waiting > 0 || event.queued > 0;
	const hasSustainedEventLoopDelay = (event.eventLoopDelayP99Ms ?? 0) >= LIVENESS_EVENT_LOOP_DELAY_WARN_MS;
	return hasBlockingWork || event.active > 0 && hasSustainedEventLoopDelay ? "warning" : "info";
}
function isRecord(record) {
	return record !== void 0;
}
function sanitizeDiagnosticEvent(event) {
	const record = {
		seq: event.seq,
		ts: event.ts,
		type: event.type
	};
	switch (event.type) {
		case "model.usage":
			record.channel = event.channel;
			record.provider = event.provider;
			record.model = event.model;
			record.usage = { ...event.usage };
			record.context = event.context ? { ...event.context } : void 0;
			record.costUsd = event.costUsd;
			record.durationMs = event.durationMs;
			break;
		case "webhook.received":
			record.channel = event.channel;
			break;
		case "webhook.processed":
			record.channel = event.channel;
			record.durationMs = event.durationMs;
			break;
		case "webhook.error":
			record.channel = event.channel;
			break;
		case "message.queued":
			record.channel = event.channel;
			record.source = event.source;
			record.queueDepth = event.queueDepth;
			break;
		case "message.received":
			record.channel = event.channel;
			record.source = event.source;
			break;
		case "message.dispatch.started":
			record.channel = event.channel;
			record.source = event.source;
			break;
		case "message.dispatch.completed":
			record.channel = event.channel;
			record.source = event.source;
			record.durationMs = event.durationMs;
			record.outcome = event.outcome;
			assignReasonCode(record, event.reason);
			break;
		case "message.processed":
			record.channel = event.channel;
			record.durationMs = event.durationMs;
			record.outcome = event.outcome;
			assignReasonCode(record, event.reason);
			break;
		case "message.delivery.started":
			record.channel = event.channel;
			record.deliveryKind = event.deliveryKind;
			break;
		case "message.delivery.completed":
			record.channel = event.channel;
			record.deliveryKind = event.deliveryKind;
			record.durationMs = event.durationMs;
			record.resultCount = event.resultCount;
			record.outcome = "completed";
			break;
		case "message.delivery.error":
			record.channel = event.channel;
			record.deliveryKind = event.deliveryKind;
			record.durationMs = event.durationMs;
			record.outcome = "error";
			assignReasonCode(record, event.errorCategory);
			break;
		case "talk.event":
			record.talkEventType = event.talkEventType;
			record.mode = event.mode;
			record.transport = event.transport;
			record.brain = event.brain;
			record.provider = event.provider;
			record.final = event.final;
			record.durationMs = event.durationMs;
			record.bytes = event.byteLength;
			break;
		case "session.state":
			record.outcome = event.state;
			assignReasonCode(record, event.reason);
			record.queueDepth = event.queueDepth;
			break;
		case "session.long_running":
		case "session.stalled":
		case "session.stuck":
			record.outcome = event.state;
			if (event.type === "session.stuck") record.level = "warning";
			assignReasonCode(record, event.reason);
			record.ageMs = event.ageMs;
			record.queueDepth = event.queueDepth;
			if (event.activeWorkKind) record.activeWorkKind = event.activeWorkKind;
			if (event.activeToolName) record.toolName = event.activeToolName;
			break;
		case "session.recovery.requested":
			record.outcome = event.state;
			record.action = event.allowActiveAbort ? "abort" : "recover";
			record.ageMs = event.ageMs;
			record.queueDepth = event.queueDepth;
			if (event.activeWorkKind) record.activeWorkKind = event.activeWorkKind;
			assignReasonCode(record, event.reason);
			break;
		case "session.recovery.completed":
			record.outcome = event.status;
			record.action = event.action;
			record.ageMs = event.ageMs;
			record.queueDepth = event.queueDepth;
			record.count = event.released;
			if (event.activeWorkKind) record.activeWorkKind = event.activeWorkKind;
			assignReasonCode(record, event.outcomeReason ?? event.reason);
			break;
		case "session.turn.created":
			record.source = event.agentId;
			record.channel = event.channel;
			record.outcome = event.trigger;
			break;
		case "queue.lane.enqueue":
			record.source = event.lane;
			record.queueSize = event.queueSize;
			break;
		case "queue.lane.dequeue":
			record.source = event.lane;
			record.queueSize = event.queueSize;
			record.waitMs = event.waitMs;
			break;
		case "run.attempt":
			record.count = event.attempt;
			break;
		case "run.progress":
			assignReasonCode(record, event.reason);
			break;
		case "context.assembled":
			record.channel = event.channel;
			record.provider = event.provider;
			record.model = event.model;
			record.count = event.messageCount;
			record.bytes = event.promptChars;
			record.context = event.contextTokenBudget !== void 0 ? { limit: event.contextTokenBudget } : void 0;
			record.bytes = event.promptChars;
			break;
		case "diagnostic.heartbeat":
			record.webhooks = { ...event.webhooks };
			record.active = event.active;
			record.waiting = event.waiting;
			record.queued = event.queued;
			break;
		case "diagnostic.liveness.warning":
			record.level = resolveDiagnosticLivenessRecordLevel(event);
			record.durationMs = event.intervalMs;
			record.count = event.reasons.length;
			assignReasonCode(record, event.reasons[0]);
			record.eventLoopDelayP99Ms = event.eventLoopDelayP99Ms;
			record.eventLoopDelayMaxMs = event.eventLoopDelayMaxMs;
			record.eventLoopUtilization = event.eventLoopUtilization;
			record.cpuCoreRatio = event.cpuCoreRatio;
			record.active = event.active;
			record.waiting = event.waiting;
			record.queued = event.queued;
			record.phase = event.phase;
			if (event.activeWorkLabels?.length) record.source = event.activeWorkLabels[0];
			else if (event.queuedWorkLabels?.length) record.source = event.queuedWorkLabels[0];
			break;
		case "diagnostic.phase.completed":
			record.phase = event.name;
			record.durationMs = event.durationMs;
			record.cpuCoreRatio = event.cpuCoreRatio;
			break;
		case "tool.loop":
			record.toolName = event.toolName;
			record.level = event.level;
			record.action = event.action;
			record.detector = event.detector;
			record.count = event.count;
			record.pairedToolName = event.pairedToolName;
			break;
		case "tool.execution.started":
			record.toolName = event.toolName;
			break;
		case "tool.execution.completed":
			record.toolName = event.toolName;
			record.durationMs = event.durationMs;
			break;
		case "tool.execution.error":
			record.toolName = event.toolName;
			record.durationMs = event.durationMs;
			assignReasonCode(record, event.errorCategory);
			break;
		case "tool.execution.blocked":
			record.toolName = event.toolName;
			record.outcome = "blocked";
			assignReasonCode(record, event.deniedReason);
			break;
		case "exec.process.completed":
			record.target = event.target;
			record.mode = event.mode;
			record.outcome = event.outcome;
			record.durationMs = event.durationMs;
			record.commandLength = event.commandLength;
			record.exitCode = event.exitCode;
			record.timedOut = event.timedOut;
			record.failureKind = event.failureKind;
			assignReasonCode(record, event.failureKind);
			break;
		case "run.started":
			record.provider = event.provider;
			record.model = event.model;
			record.channel = event.channel;
			break;
		case "run.completed":
			record.provider = event.provider;
			record.model = event.model;
			record.channel = event.channel;
			record.durationMs = event.durationMs;
			record.outcome = event.outcome;
			assignReasonCode(record, event.errorCategory);
			break;
		case "harness.run.started":
			record.source = event.harnessId;
			record.pluginId = event.pluginId;
			record.provider = event.provider;
			record.model = event.model;
			record.channel = event.channel;
			break;
		case "harness.run.completed":
			record.source = event.harnessId;
			record.pluginId = event.pluginId;
			record.provider = event.provider;
			record.model = event.model;
			record.channel = event.channel;
			record.durationMs = event.durationMs;
			record.outcome = event.outcome;
			record.count = event.itemLifecycle?.completedCount;
			break;
		case "harness.run.error":
			record.source = event.harnessId;
			record.pluginId = event.pluginId;
			record.provider = event.provider;
			record.model = event.model;
			record.channel = event.channel;
			record.durationMs = event.durationMs;
			record.outcome = "error";
			record.action = event.phase;
			assignReasonCode(record, event.errorCategory);
			break;
		case "model.call.started":
			record.provider = event.provider;
			record.model = event.model;
			break;
		case "model.call.completed":
			record.provider = event.provider;
			record.model = event.model;
			record.durationMs = event.durationMs;
			record.requestBytes = event.requestPayloadBytes;
			record.responseBytes = event.responseStreamBytes;
			record.timeToFirstByteMs = event.timeToFirstByteMs;
			break;
		case "model.call.error":
			record.provider = event.provider;
			record.model = event.model;
			record.durationMs = event.durationMs;
			record.requestBytes = event.requestPayloadBytes;
			record.responseBytes = event.responseStreamBytes;
			record.timeToFirstByteMs = event.timeToFirstByteMs;
			record.failureKind = event.failureKind;
			record.memory = event.memory ? copyMemory(event.memory) : void 0;
			assignReasonCode(record, event.errorCategory);
			break;
		case "log.record":
			record.level = event.level;
			record.source = event.loggerName;
			break;
		case "diagnostic.memory.sample":
			record.memory = copyMemory(event.memory);
			break;
		case "diagnostic.memory.pressure":
			record.level = event.level;
			assignReasonCode(record, event.reason);
			record.memory = copyMemory(event.memory);
			record.thresholdBytes = event.thresholdBytes;
			record.rssGrowthBytes = event.rssGrowthBytes;
			record.windowMs = event.windowMs;
			break;
		case "payload.large":
			record.surface = event.surface;
			record.action = event.action;
			record.bytes = event.bytes;
			record.limitBytes = event.limitBytes;
			record.count = event.count;
			record.channel = event.channel;
			record.pluginId = event.pluginId;
			assignReasonCode(record, event.reason);
			break;
		case "telemetry.exporter":
			record.source = event.exporter;
			record.target = event.signal;
			record.outcome = event.status;
			assignReasonCode(record, event.reason ?? event.errorCategory);
			break;
		case "diagnostic.async_queue.dropped":
			record.droppedEvents = event.droppedEvents;
			record.droppedTrustedEvents = event.droppedTrustedEvents;
			record.droppedUntrustedEvents = event.droppedUntrustedEvents;
			record.droppedPriorityEvents = event.droppedPriorityEvents;
			record.queueLength = event.queueLength;
			record.maxQueueLength = event.maxQueueLength;
			record.drainBatchSize = event.drainBatchSize;
			break;
		case "model.failover":
			record.provider = event.fromProvider;
			record.model = event.fromModel;
			assignReasonCode(record, event.reason);
			break;
	}
	return record;
}
function appendRecord(record) {
	const state = getDiagnosticStabilityState();
	state.records[state.nextIndex] = record;
	state.nextIndex = (state.nextIndex + 1) % state.capacity;
	if (state.count < state.capacity) {
		state.count += 1;
		return;
	}
	state.dropped += 1;
}
function listRecords() {
	const state = getDiagnosticStabilityState();
	if (state.count === 0) return [];
	if (state.count < state.capacity) return state.records.slice(0, state.count).filter(isRecord);
	return [...state.records.slice(state.nextIndex), ...state.records.slice(0, state.nextIndex)].filter(isRecord);
}
function summarizeRecords(records) {
	const byType = {};
	let latestMemory;
	let maxRssBytes;
	let maxHeapUsedBytes;
	let pressureCount = 0;
	const payloadLarge = {
		count: 0,
		rejected: 0,
		truncated: 0,
		chunked: 0,
		bySurface: {}
	};
	for (const record of records) {
		byType[record.type] = (byType[record.type] ?? 0) + 1;
		if (record.memory) {
			latestMemory = record.memory;
			maxRssBytes = maxRssBytes === void 0 ? record.memory.rssBytes : Math.max(maxRssBytes, record.memory.rssBytes);
			maxHeapUsedBytes = maxHeapUsedBytes === void 0 ? record.memory.heapUsedBytes : Math.max(maxHeapUsedBytes, record.memory.heapUsedBytes);
		}
		if (record.type === "diagnostic.memory.pressure") pressureCount += 1;
		if (record.type === "payload.large") {
			payloadLarge.count += 1;
			if (record.action === "rejected") payloadLarge.rejected += 1;
			else if (record.action === "truncated") payloadLarge.truncated += 1;
			else if (record.action === "chunked") payloadLarge.chunked += 1;
			const surface = record.surface ?? "unknown";
			payloadLarge.bySurface[surface] = (payloadLarge.bySurface[surface] ?? 0) + 1;
		}
	}
	return {
		byType,
		...latestMemory || pressureCount > 0 ? { memory: {
			latest: latestMemory,
			maxRssBytes,
			maxHeapUsedBytes,
			pressureCount
		} } : {},
		...payloadLarge.count > 0 ? { payloadLarge } : {}
	};
}
function selectRecords(records, options) {
	const { limit, type, sinceSeq } = normalizeDiagnosticStabilityQuery(options);
	const filtered = records.filter((record) => {
		if (type && record.type !== type) return false;
		if (sinceSeq !== void 0 && record.seq <= sinceSeq) return false;
		return true;
	});
	return {
		filtered,
		events: filtered.slice(Math.max(0, filtered.length - limit))
	};
}
function parseOptionalNonNegativeInteger(value, field) {
	if (value === void 0 || value === null || value === "") return;
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`);
	return parsed;
}
function parseOptionalType(value) {
	if (value === void 0 || value === null || value === "") return;
	if (typeof value !== "string" || value.trim() === "") throw new Error("type must be a non-empty string");
	return value.trim();
}
function normalizeLimit(limit, defaultLimit = DEFAULT_DIAGNOSTIC_STABILITY_LIMIT) {
	const parsed = parseOptionalNonNegativeInteger(limit, "limit");
	if (parsed === void 0) return defaultLimit;
	if (parsed < 1 || parsed > 1e3) throw new Error(`limit must be between 1 and ${MAX_DIAGNOSTIC_STABILITY_LIMIT}`);
	return parsed;
}
function normalizeDiagnosticStabilityQuery(input = {}, options) {
	return {
		limit: normalizeLimit(input.limit, options?.defaultLimit),
		type: parseOptionalType(input.type),
		sinceSeq: parseOptionalNonNegativeInteger(input.sinceSeq, "sinceSeq")
	};
}
function startDiagnosticStabilityRecorder() {
	const state = getDiagnosticStabilityState();
	if (state.unsubscribe) return;
	state.unsubscribe = onDiagnosticEvent((event) => {
		appendRecord(sanitizeDiagnosticEvent(event));
	});
}
function stopDiagnosticStabilityRecorder() {
	const state = getDiagnosticStabilityState();
	state.unsubscribe?.();
	state.unsubscribe = null;
}
function getDiagnosticStabilitySnapshot(options) {
	const state = getDiagnosticStabilityState();
	const { filtered, events } = selectRecords(listRecords(), options);
	return {
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		capacity: state.capacity,
		count: filtered.length,
		dropped: state.dropped,
		firstSeq: filtered[0]?.seq,
		lastSeq: filtered.at(-1)?.seq,
		events,
		summary: summarizeRecords(filtered)
	};
}
function selectDiagnosticStabilitySnapshot(snapshot, options) {
	const { filtered, events } = selectRecords(snapshot.events, options);
	return {
		...snapshot,
		count: filtered.length,
		firstSeq: filtered[0]?.seq,
		lastSeq: filtered.at(-1)?.seq,
		events,
		summary: summarizeRecords(filtered)
	};
}
function resetDiagnosticStabilityRecorderForTest() {
	const state = getDiagnosticStabilityState();
	state.unsubscribe?.();
	const next = createState(state.capacity);
	const globalStore = globalThis;
	globalStore["__openclawDiagnosticStabilityState"] = next;
}
//#endregion
export { selectDiagnosticStabilitySnapshot as a, resetDiagnosticStabilityRecorderForTest as i, getDiagnosticStabilitySnapshot as n, startDiagnosticStabilityRecorder as o, normalizeDiagnosticStabilityQuery as r, stopDiagnosticStabilityRecorder as s, MAX_DIAGNOSTIC_STABILITY_LIMIT as t };
