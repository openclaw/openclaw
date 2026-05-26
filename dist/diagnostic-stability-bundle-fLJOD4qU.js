import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as registerFatalErrorHook } from "./fatal-error-hooks-gDVRMZSa.js";
import { i as replaceFileAtomicSync } from "./replace-file-C7_Inj8B.js";
import { n as getDiagnosticStabilitySnapshot, t as MAX_DIAGNOSTIC_STABILITY_LIMIT } from "./diagnostic-stability-BzQFUHBy.js";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
//#region src/logging/diagnostic-stability-bundle.ts
const DIAGNOSTIC_STABILITY_BUNDLE_VERSION = 1;
const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT = MAX_DIAGNOSTIC_STABILITY_LIMIT;
const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION = 20;
const MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES = 5 * 1024 * 1024;
const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const BUNDLE_PREFIX = "openclaw-stability-";
const BUNDLE_SUFFIX = ".json";
const REDACTED_HOSTNAME = "<redacted-hostname>";
const MAX_SAFE_ERROR_MESSAGE_LENGTH = 500;
const MAX_ACTIVE_RESOURCE_TYPES = 25;
const MAX_SESSION_FILE_RESULTS = 20;
const MAX_SESSION_SCAN_AGENTS = 100;
const MAX_SESSION_SCAN_FILES = 5e3;
const CGROUP_V2_MEMORY_FILES = [
	"current",
	"max",
	"high",
	"peak",
	"swap.current",
	"swap.max"
];
const CGROUP_V2_MEMORY_EVENTS = ["events", "events.local"];
let fatalHookUnsubscribe = null;
function normalizeReason(reason) {
	return SAFE_REASON_CODE.test(reason) ? reason : "unknown";
}
function formatBundleTimestamp(now) {
	return now.toISOString().replace(/[:.]/g, "-");
}
function readErrorCode(error) {
	if (!error || typeof error !== "object" || !("code" in error)) return;
	const code = error.code;
	if (typeof code === "string" && SAFE_REASON_CODE.test(code)) return code;
	if (typeof code === "number" && Number.isFinite(code)) return String(code);
}
function readErrorName(error) {
	if (!error || typeof error !== "object" || !("name" in error)) return;
	const name = error.name;
	return typeof name === "string" && SAFE_REASON_CODE.test(name) ? name : void 0;
}
function readErrorMessage(error) {
	if (!error || typeof error !== "object" || !("message" in error)) return;
	const message = error.message;
	if (typeof message !== "string") return;
	const sanitized = redactSensitiveText(message, { mode: "tools" }).replace(/\s+/gu, " ").trim();
	if (!sanitized) return;
	return sanitized.length > MAX_SAFE_ERROR_MESSAGE_LENGTH ? `${sanitized.slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH)}...` : sanitized;
}
function readSafeErrorMetadata(error) {
	const name = readErrorName(error);
	const code = readErrorCode(error);
	const message = readErrorMessage(error);
	if (!name && !code && !message) return;
	return {
		...name ? { name } : {},
		...code ? { code } : {},
		...message ? { message } : {}
	};
}
function resolveDiagnosticStabilityBundleDir(options = {}) {
	return path.join(options.stateDir ?? resolveStateDir(options.env ?? process.env), "logs", "stability");
}
function buildBundlePath(dir, now, reason) {
	return path.join(dir, `${BUNDLE_PREFIX}${formatBundleTimestamp(now)}-${process.pid}-${normalizeReason(reason)}${BUNDLE_SUFFIX}`);
}
function isBundleFile(name) {
	return name.startsWith(BUNDLE_PREFIX) && name.endsWith(BUNDLE_SUFFIX);
}
function isMissingFileError(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function readObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid stability bundle: ${label} must be an object`);
	return value;
}
function readNumber(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid stability bundle: ${label} must be a finite number`);
	return value;
}
function readOptionalPositiveInteger(value, label) {
	if (value === void 0) return;
	const parsed = readNumber(value, label);
	return parsed >= 0 ? Math.floor(parsed) : void 0;
}
function readTimestampMs(value, label) {
	const timestamp = readNumber(value, label);
	if (Number.isNaN(new Date(timestamp).getTime())) throw new Error(`Invalid stability bundle: ${label} must be a valid timestamp`);
	return timestamp;
}
function readOptionalNumber(value, label) {
	if (value === void 0) return;
	return readNumber(value, label);
}
function readString(value, label) {
	if (typeof value !== "string") throw new Error(`Invalid stability bundle: ${label} must be a string`);
	return value;
}
function readTimestampString(value, label) {
	const timestamp = readString(value, label);
	if (Number.isNaN(new Date(timestamp).getTime())) throw new Error(`Invalid stability bundle: ${label} must be a valid timestamp`);
	return timestamp;
}
function readCodeString(value, label) {
	const code = readString(value, label);
	if (!SAFE_REASON_CODE.test(code)) throw new Error(`Invalid stability bundle: ${label} must be a safe diagnostic code`);
	return code;
}
function readOptionalCodeString(value, label) {
	if (value === void 0) return;
	const code = readString(value, label);
	return SAFE_REASON_CODE.test(code) ? code : void 0;
}
function assignOptionalNumber(target, key, value, label) {
	const parsed = readOptionalNumber(value, label);
	if (parsed !== void 0) target[key] = parsed;
}
function assignOptionalPositiveInteger(target, key, value, label) {
	const parsed = readOptionalPositiveInteger(value, label);
	if (parsed !== void 0) target[key] = parsed;
}
function assignOptionalCodeString(target, key, value, label) {
	const parsed = readOptionalCodeString(value, label);
	if (parsed !== void 0) target[key] = parsed;
}
function readMemoryUsage(value, label) {
	const memory = readObject(value, label);
	return {
		rssBytes: readNumber(memory.rssBytes, `${label}.rssBytes`),
		heapTotalBytes: readNumber(memory.heapTotalBytes, `${label}.heapTotalBytes`),
		heapUsedBytes: readNumber(memory.heapUsedBytes, `${label}.heapUsedBytes`),
		externalBytes: readNumber(memory.externalBytes, `${label}.externalBytes`),
		arrayBuffersBytes: readNumber(memory.arrayBuffersBytes, `${label}.arrayBuffersBytes`)
	};
}
function readHeapStatistics(value) {
	if (value === void 0) return;
	const source = readObject(value, "evidence.memoryPressure.heapStatistics");
	const result = {};
	assignOptionalPositiveInteger(result, "totalHeapSizeBytes", source.totalHeapSizeBytes, "evidence.memoryPressure.heapStatistics.totalHeapSizeBytes");
	assignOptionalPositiveInteger(result, "totalHeapSizeExecutableBytes", source.totalHeapSizeExecutableBytes, "evidence.memoryPressure.heapStatistics.totalHeapSizeExecutableBytes");
	assignOptionalPositiveInteger(result, "totalPhysicalSizeBytes", source.totalPhysicalSizeBytes, "evidence.memoryPressure.heapStatistics.totalPhysicalSizeBytes");
	assignOptionalPositiveInteger(result, "totalAvailableSizeBytes", source.totalAvailableSizeBytes, "evidence.memoryPressure.heapStatistics.totalAvailableSizeBytes");
	assignOptionalPositiveInteger(result, "usedHeapSizeBytes", source.usedHeapSizeBytes, "evidence.memoryPressure.heapStatistics.usedHeapSizeBytes");
	assignOptionalPositiveInteger(result, "heapSizeLimitBytes", source.heapSizeLimitBytes, "evidence.memoryPressure.heapStatistics.heapSizeLimitBytes");
	assignOptionalPositiveInteger(result, "mallocedMemoryBytes", source.mallocedMemoryBytes, "evidence.memoryPressure.heapStatistics.mallocedMemoryBytes");
	assignOptionalPositiveInteger(result, "externalMemoryBytes", source.externalMemoryBytes, "evidence.memoryPressure.heapStatistics.externalMemoryBytes");
	return Object.keys(result).length > 0 ? result : void 0;
}
function readHeapSpaces(value) {
	if (value === void 0) return;
	if (!Array.isArray(value)) throw new Error("Invalid stability bundle: evidence.memoryPressure.heapSpaces must be an array");
	const spaces = [];
	for (const [index, entry] of value.entries()) {
		const source = readObject(entry, `evidence.memoryPressure.heapSpaces[${index}]`);
		const spaceName = readOptionalCodeString(source.spaceName, `evidence.memoryPressure.heapSpaces[${index}].spaceName`);
		if (!spaceName) continue;
		spaces.push({
			spaceName,
			spaceSizeBytes: readOptionalPositiveInteger(source.spaceSizeBytes, `evidence.memoryPressure.heapSpaces[${index}].spaceSizeBytes`) ?? 0,
			spaceUsedBytes: readOptionalPositiveInteger(source.spaceUsedBytes, `evidence.memoryPressure.heapSpaces[${index}].spaceUsedBytes`) ?? 0,
			spaceAvailableBytes: readOptionalPositiveInteger(source.spaceAvailableBytes, `evidence.memoryPressure.heapSpaces[${index}].spaceAvailableBytes`) ?? 0,
			physicalSpaceSizeBytes: readOptionalPositiveInteger(source.physicalSpaceSizeBytes, `evidence.memoryPressure.heapSpaces[${index}].physicalSpaceSizeBytes`) ?? 0
		});
	}
	return spaces.length > 0 ? spaces : void 0;
}
function readCgroupMemorySummary(value) {
	if (value === void 0) return;
	const source = readObject(value, "evidence.memoryPressure.cgroup");
	const version = readCodeString(source.version, "evidence.memoryPressure.cgroup.version");
	if (version !== "v2") return;
	const valuesSource = readObject(source.values, "evidence.memoryPressure.cgroup.values");
	const values = {};
	for (const [key, raw] of Object.entries(valuesSource)) {
		if (!SAFE_REASON_CODE.test(key)) continue;
		if (raw === "max") values[key] = "max";
		else values[key] = readOptionalPositiveInteger(raw, `evidence.memoryPressure.cgroup.values.${key}`) ?? 0;
	}
	return {
		version,
		values,
		events: readNumberMap(source.events, "evidence.memoryPressure.cgroup.events")
	};
}
function readActiveResources(value) {
	if (value === void 0) return;
	const source = readObject(value, "evidence.memoryPressure.activeResources");
	return {
		total: readOptionalPositiveInteger(source.total, "evidence.memoryPressure.activeResources.total") ?? 0,
		byType: readNumberMap(source.byType, "evidence.memoryPressure.activeResources.byType")
	};
}
function readSessionFiles(value) {
	if (value === void 0) return;
	if (!Array.isArray(value)) throw new Error("Invalid stability bundle: evidence.memoryPressure.topSessionFiles must be an array");
	const files = [];
	for (const [index, entry] of value.entries()) {
		const source = readObject(entry, `evidence.memoryPressure.topSessionFiles[${index}]`);
		const relativePath = readString(source.relativePath, `evidence.memoryPressure.topSessionFiles[${index}].relativePath`);
		if (path.isAbsolute(relativePath) || relativePath.includes("..") || relativePath.length > 300 || /[\r\n]/u.test(relativePath)) continue;
		files.push({
			relativePath: sanitizeSessionEvidencePath(relativePath),
			sizeBytes: readOptionalPositiveInteger(source.sizeBytes, `evidence.memoryPressure.topSessionFiles[${index}].sizeBytes`) ?? 0,
			mtimeMs: readOptionalPositiveInteger(source.mtimeMs, `evidence.memoryPressure.topSessionFiles[${index}].mtimeMs`) ?? 0
		});
	}
	return files.length > 0 ? files : void 0;
}
function readMemoryPressureEvidence(value) {
	if (value === void 0) return;
	const pressure = readObject(value, "evidence.memoryPressure");
	const level = readCodeString(pressure.level, "evidence.memoryPressure.level");
	const reason = readCodeString(pressure.reason, "evidence.memoryPressure.reason");
	if (level !== "warning" && level !== "critical" || !isMemoryPressureReason(reason)) return;
	const heapStatistics = readHeapStatistics(pressure.heapStatistics);
	const heapSpaces = readHeapSpaces(pressure.heapSpaces);
	const cgroup = readCgroupMemorySummary(pressure.cgroup);
	const activeResources = readActiveResources(pressure.activeResources);
	const topSessionFiles = readSessionFiles(pressure.topSessionFiles);
	return {
		level,
		reason,
		memory: readMemoryUsage(pressure.memory, "evidence.memoryPressure.memory"),
		...pressure.thresholdBytes !== void 0 ? { thresholdBytes: readNumber(pressure.thresholdBytes, "evidence.memoryPressure.thresholdBytes") } : {},
		...pressure.rssGrowthBytes !== void 0 ? { rssGrowthBytes: readNumber(pressure.rssGrowthBytes, "evidence.memoryPressure.rssGrowthBytes") } : {},
		...pressure.windowMs !== void 0 ? { windowMs: readNumber(pressure.windowMs, "evidence.memoryPressure.windowMs") } : {},
		...heapStatistics ? { heapStatistics } : {},
		...heapSpaces ? { heapSpaces } : {},
		...cgroup ? { cgroup } : {},
		...activeResources ? { activeResources } : {},
		...topSessionFiles ? { topSessionFiles } : {}
	};
}
function readBundleEvidence(value) {
	if (value === void 0) return;
	const memoryPressure = readMemoryPressureEvidence(readObject(value, "evidence").memoryPressure);
	return memoryPressure ? { memoryPressure } : void 0;
}
function readNumberMap(value, label) {
	const source = readObject(value, label);
	const result = {};
	for (const [key, entry] of Object.entries(source)) {
		if (!SAFE_REASON_CODE.test(key)) continue;
		result[key] = readNumber(entry, `${label}.${key}`);
	}
	return result;
}
function readOptionalMemorySummary(value) {
	if (value === void 0) return;
	const memory = readObject(value, "snapshot.summary.memory");
	const latest = memory.latest === void 0 ? void 0 : readMemoryUsage(memory.latest, "snapshot.summary.memory.latest");
	return {
		...latest ? { latest } : {},
		...memory.maxRssBytes !== void 0 ? { maxRssBytes: readNumber(memory.maxRssBytes, "snapshot.summary.memory.maxRssBytes") } : {},
		...memory.maxHeapUsedBytes !== void 0 ? { maxHeapUsedBytes: readNumber(memory.maxHeapUsedBytes, "snapshot.summary.memory.maxHeapUsedBytes") } : {},
		pressureCount: readNumber(memory.pressureCount, "snapshot.summary.memory.pressureCount")
	};
}
function readOptionalPayloadLargeSummary(value) {
	if (value === void 0) return;
	const payloadLarge = readObject(value, "snapshot.summary.payloadLarge");
	return {
		count: readNumber(payloadLarge.count, "snapshot.summary.payloadLarge.count"),
		rejected: readNumber(payloadLarge.rejected, "snapshot.summary.payloadLarge.rejected"),
		truncated: readNumber(payloadLarge.truncated, "snapshot.summary.payloadLarge.truncated"),
		chunked: readNumber(payloadLarge.chunked, "snapshot.summary.payloadLarge.chunked"),
		bySurface: readNumberMap(payloadLarge.bySurface, "snapshot.summary.payloadLarge.bySurface")
	};
}
function readStabilityEventRecord(value, label) {
	const record = readObject(value, label);
	const sanitized = {
		seq: readNumber(record.seq, `${label}.seq`),
		ts: readTimestampMs(record.ts, `${label}.ts`),
		type: readCodeString(record.type, `${label}.type`)
	};
	assignOptionalCodeString(sanitized, "channel", record.channel, `${label}.channel`);
	assignOptionalCodeString(sanitized, "pluginId", record.pluginId, `${label}.pluginId`);
	assignOptionalCodeString(sanitized, "source", record.source, `${label}.source`);
	assignOptionalCodeString(sanitized, "surface", record.surface, `${label}.surface`);
	assignOptionalCodeString(sanitized, "action", record.action, `${label}.action`);
	assignOptionalCodeString(sanitized, "reason", record.reason, `${label}.reason`);
	assignOptionalCodeString(sanitized, "outcome", record.outcome, `${label}.outcome`);
	assignOptionalCodeString(sanitized, "level", record.level, `${label}.level`);
	assignOptionalCodeString(sanitized, "phase", record.phase, `${label}.phase`);
	assignOptionalCodeString(sanitized, "detector", record.detector, `${label}.detector`);
	assignOptionalCodeString(sanitized, "toolName", record.toolName, `${label}.toolName`);
	assignOptionalCodeString(sanitized, "activeWorkKind", record.activeWorkKind, `${label}.activeWorkKind`);
	assignOptionalCodeString(sanitized, "pairedToolName", record.pairedToolName, `${label}.pairedToolName`);
	assignOptionalCodeString(sanitized, "provider", record.provider, `${label}.provider`);
	assignOptionalCodeString(sanitized, "model", record.model, `${label}.model`);
	assignOptionalNumber(sanitized, "durationMs", record.durationMs, `${label}.durationMs`);
	assignOptionalNumber(sanitized, "requestBytes", record.requestBytes, `${label}.requestBytes`);
	assignOptionalNumber(sanitized, "responseBytes", record.responseBytes, `${label}.responseBytes`);
	assignOptionalNumber(sanitized, "timeToFirstByteMs", record.timeToFirstByteMs, `${label}.timeToFirstByteMs`);
	assignOptionalNumber(sanitized, "costUsd", record.costUsd, `${label}.costUsd`);
	assignOptionalNumber(sanitized, "count", record.count, `${label}.count`);
	assignOptionalNumber(sanitized, "bytes", record.bytes, `${label}.bytes`);
	assignOptionalNumber(sanitized, "limitBytes", record.limitBytes, `${label}.limitBytes`);
	assignOptionalNumber(sanitized, "thresholdBytes", record.thresholdBytes, `${label}.thresholdBytes`);
	assignOptionalNumber(sanitized, "rssGrowthBytes", record.rssGrowthBytes, `${label}.rssGrowthBytes`);
	assignOptionalNumber(sanitized, "windowMs", record.windowMs, `${label}.windowMs`);
	assignOptionalNumber(sanitized, "ageMs", record.ageMs, `${label}.ageMs`);
	assignOptionalNumber(sanitized, "queueDepth", record.queueDepth, `${label}.queueDepth`);
	assignOptionalNumber(sanitized, "queueSize", record.queueSize, `${label}.queueSize`);
	assignOptionalNumber(sanitized, "queueLength", record.queueLength, `${label}.queueLength`);
	assignOptionalNumber(sanitized, "waitMs", record.waitMs, `${label}.waitMs`);
	assignOptionalNumber(sanitized, "active", record.active, `${label}.active`);
	assignOptionalNumber(sanitized, "waiting", record.waiting, `${label}.waiting`);
	assignOptionalNumber(sanitized, "queued", record.queued, `${label}.queued`);
	assignOptionalNumber(sanitized, "droppedEvents", record.droppedEvents, `${label}.droppedEvents`);
	assignOptionalNumber(sanitized, "droppedTrustedEvents", record.droppedTrustedEvents, `${label}.droppedTrustedEvents`);
	assignOptionalNumber(sanitized, "droppedUntrustedEvents", record.droppedUntrustedEvents, `${label}.droppedUntrustedEvents`);
	assignOptionalNumber(sanitized, "droppedPriorityEvents", record.droppedPriorityEvents, `${label}.droppedPriorityEvents`);
	assignOptionalNumber(sanitized, "maxQueueLength", record.maxQueueLength, `${label}.maxQueueLength`);
	assignOptionalNumber(sanitized, "drainBatchSize", record.drainBatchSize, `${label}.drainBatchSize`);
	if (record.webhooks !== void 0) {
		const webhooks = readObject(record.webhooks, `${label}.webhooks`);
		sanitized.webhooks = {
			received: readNumber(webhooks.received, `${label}.webhooks.received`),
			processed: readNumber(webhooks.processed, `${label}.webhooks.processed`),
			errors: readNumber(webhooks.errors, `${label}.webhooks.errors`)
		};
	}
	if (record.memory !== void 0) sanitized.memory = readMemoryUsage(record.memory, `${label}.memory`);
	if (record.usage !== void 0) {
		const usage = readObject(record.usage, `${label}.usage`);
		sanitized.usage = {
			...usage.input !== void 0 ? { input: readNumber(usage.input, `${label}.usage.input`) } : {},
			...usage.output !== void 0 ? { output: readNumber(usage.output, `${label}.usage.output`) } : {},
			...usage.cacheRead !== void 0 ? { cacheRead: readNumber(usage.cacheRead, `${label}.usage.cacheRead`) } : {},
			...usage.cacheWrite !== void 0 ? { cacheWrite: readNumber(usage.cacheWrite, `${label}.usage.cacheWrite`) } : {},
			...usage.promptTokens !== void 0 ? { promptTokens: readNumber(usage.promptTokens, `${label}.usage.promptTokens`) } : {},
			...usage.total !== void 0 ? { total: readNumber(usage.total, `${label}.usage.total`) } : {}
		};
	}
	if (record.context !== void 0) {
		const context = readObject(record.context, `${label}.context`);
		sanitized.context = {
			...context.limit !== void 0 ? { limit: readNumber(context.limit, `${label}.context.limit`) } : {},
			...context.used !== void 0 ? { used: readNumber(context.used, `${label}.context.used`) } : {}
		};
	}
	return sanitized;
}
function readStabilitySnapshot(value) {
	const snapshot = readObject(value, "snapshot");
	const generatedAt = readTimestampString(snapshot.generatedAt, "snapshot.generatedAt");
	const capacity = readNumber(snapshot.capacity, "snapshot.capacity");
	const count = readNumber(snapshot.count, "snapshot.count");
	const dropped = readNumber(snapshot.dropped, "snapshot.dropped");
	const firstSeq = readOptionalNumber(snapshot.firstSeq, "snapshot.firstSeq");
	const lastSeq = readOptionalNumber(snapshot.lastSeq, "snapshot.lastSeq");
	if (!Array.isArray(snapshot.events)) throw new Error("Invalid stability bundle: snapshot.events must be an array");
	const events = snapshot.events.map((event, index) => readStabilityEventRecord(event, `snapshot.events[${index}]`));
	const summary = readObject(snapshot.summary, "snapshot.summary");
	return {
		generatedAt,
		capacity,
		count,
		dropped,
		...firstSeq !== void 0 ? { firstSeq } : {},
		...lastSeq !== void 0 ? { lastSeq } : {},
		events,
		summary: {
			byType: readNumberMap(summary.byType, "snapshot.summary.byType"),
			...summary.memory !== void 0 ? { memory: readOptionalMemorySummary(summary.memory) } : {},
			...summary.payloadLarge !== void 0 ? { payloadLarge: readOptionalPayloadLargeSummary(summary.payloadLarge) } : {}
		}
	};
}
function parseDiagnosticStabilityBundle(value) {
	const bundle = readObject(value, "bundle");
	if (bundle.version !== 1) throw new Error(`Unsupported stability bundle version: ${String(bundle.version)}`);
	const processInfo = readObject(bundle.process, "process");
	readObject(bundle.host, "host");
	const error = bundle.error === void 0 ? void 0 : readSafeErrorMetadata(bundle.error);
	const evidence = readBundleEvidence(bundle.evidence);
	return {
		version: 1,
		generatedAt: readTimestampString(bundle.generatedAt, "generatedAt"),
		reason: normalizeReason(readString(bundle.reason, "reason")),
		process: {
			pid: readNumber(processInfo.pid, "process.pid"),
			platform: readCodeString(processInfo.platform, "process.platform"),
			arch: readCodeString(processInfo.arch, "process.arch"),
			node: readCodeString(processInfo.node, "process.node"),
			uptimeMs: readNumber(processInfo.uptimeMs, "process.uptimeMs")
		},
		host: { hostname: REDACTED_HOSTNAME },
		...error ? { error } : {},
		...evidence ? { evidence } : {},
		snapshot: readStabilitySnapshot(bundle.snapshot)
	};
}
function readPositiveMemoryFile(file) {
	try {
		const raw = fs.readFileSync(file, "utf8").trim();
		if (raw === "max") return "max";
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
	} catch {
		return;
	}
}
function readCgroupEventFile(file) {
	try {
		const events = {};
		for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
			const [key, raw] = line.trim().split(/\s+/u);
			if (!key || !SAFE_REASON_CODE.test(key)) continue;
			const value = Number.parseInt(raw ?? "", 10);
			if (Number.isFinite(value) && value >= 0) events[key] = value;
		}
		return events;
	} catch {
		return {};
	}
}
function resolveCgroupV2MemoryDir() {
	if (process.platform !== "linux") return;
	try {
		const line = fs.readFileSync("/proc/self/cgroup", "utf8").split(/\r?\n/u).find((entry) => entry.startsWith("0::"));
		if (!line) return;
		const relative = line.slice(3).trim().replace(/^\/+/u, "");
		return path.join("/sys/fs/cgroup", relative);
	} catch {
		return;
	}
}
function collectCgroupMemorySummary() {
	const dir = resolveCgroupV2MemoryDir();
	if (!dir) return;
	const values = {};
	for (const name of CGROUP_V2_MEMORY_FILES) {
		const value = readPositiveMemoryFile(path.join(dir, `memory.${name}`));
		if (value !== void 0) values[name] = value;
	}
	const events = {};
	for (const name of CGROUP_V2_MEMORY_EVENTS) {
		const parsed = readCgroupEventFile(path.join(dir, `memory.${name}`));
		for (const [key, value] of Object.entries(parsed)) events[name === "events" ? key : `${name}.${key}`] = value;
	}
	return Object.keys(values).length > 0 || Object.keys(events).length > 0 ? {
		version: "v2",
		values,
		events
	} : void 0;
}
function collectHeapStatistics() {
	try {
		const stats = v8.getHeapStatistics();
		return {
			totalHeapSizeBytes: stats.total_heap_size,
			totalHeapSizeExecutableBytes: stats.total_heap_size_executable,
			totalPhysicalSizeBytes: stats.total_physical_size,
			totalAvailableSizeBytes: stats.total_available_size,
			usedHeapSizeBytes: stats.used_heap_size,
			heapSizeLimitBytes: stats.heap_size_limit,
			mallocedMemoryBytes: stats.malloced_memory,
			externalMemoryBytes: stats.external_memory
		};
	} catch {
		return;
	}
}
function collectHeapSpaces() {
	try {
		const spaces = v8.getHeapSpaceStatistics().map((space) => ({
			spaceName: space.space_name,
			spaceSizeBytes: space.space_size,
			spaceUsedBytes: space.space_used_size,
			spaceAvailableBytes: space.space_available_size,
			physicalSpaceSizeBytes: space.physical_space_size
		}));
		return spaces.length > 0 ? spaces : void 0;
	} catch {
		return;
	}
}
function collectActiveResources() {
	try {
		if (typeof process.getActiveResourcesInfo !== "function") return;
		const names = process.getActiveResourcesInfo();
		const byType = {};
		for (const name of names) {
			if (!SAFE_REASON_CODE.test(name)) continue;
			byType[name] = (byType[name] ?? 0) + 1;
		}
		const sorted = Object.entries(byType).toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_ACTIVE_RESOURCE_TYPES);
		return {
			total: names.length,
			byType: Object.fromEntries(sorted)
		};
	} catch {
		return;
	}
}
function sanitizeSessionEvidencePath(relativePath) {
	const parts = relativePath.split("/");
	if (parts.length === 4 && parts[0] === "agents" && parts[2] === "sessions") return `agents/<agent>/sessions/${sanitizeSessionEvidenceFileName(parts[3])}`;
	if (parts.length === 2 && parts[0] === "sessions") return `sessions/${sanitizeSessionEvidenceFileName(parts[1])}`;
	return redactSensitiveText(relativePath, { mode: "tools" });
}
function sanitizeSessionEvidenceFileName(fileName) {
	if (fileName === "sessions.json") return "sessions.json";
	if (fileName.endsWith(".jsonl")) return "<session>.jsonl";
	if (fileName.endsWith(".json")) return "<session>.json";
	return "<session>";
}
function visitDirentsBounded(dir, maxEntries, visitor) {
	if (maxEntries <= 0) return;
	let handle;
	try {
		handle = fs.opendirSync(dir);
		for (let count = 0; count < maxEntries; count += 1) {
			const entry = handle.readSync();
			if (!entry || visitor(entry) === false) return;
		}
	} catch {} finally {
		try {
			handle?.closeSync();
		} catch {}
	}
}
function pushSessionFileSummary(results, stateDir, file, relativePathOverride) {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return;
		const relativePath = (relativePathOverride ?? path.relative(stateDir, file)).replace(/\\/gu, "/");
		if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) return;
		results.push({
			relativePath: sanitizeSessionEvidencePath(relativePath),
			sizeBytes: stat.size,
			mtimeMs: stat.mtimeMs
		});
	} catch {}
}
function scanSessionDirectory(params) {
	const sessionsDir = path.resolve(params.sessionsDir);
	if (params.seenDirs.has(sessionsDir)) return;
	params.seenDirs.add(sessionsDir);
	visitDirentsBounded(sessionsDir, MAX_SESSION_SCAN_FILES - params.scannedSessionEntries.count, (sessionEntry) => {
		params.scannedSessionEntries.count += 1;
		if (!sessionEntry.isFile() || !/\.(?:jsonl|json)$/u.test(sessionEntry.name)) return params.scannedSessionEntries.count < MAX_SESSION_SCAN_FILES;
		pushSessionFileSummary(params.results, params.stateDir, path.join(sessionsDir, sessionEntry.name), path.posix.join(params.relativePrefix, sessionEntry.name));
		return params.scannedSessionEntries.count < MAX_SESSION_SCAN_FILES;
	});
}
function collectTopSessionFiles(stateDir, sessionStorePaths = []) {
	const results = [];
	const seenDirs = /* @__PURE__ */ new Set();
	const scannedSessionEntries = { count: 0 };
	try {
		pushSessionFileSummary(results, stateDir, path.join(stateDir, "sessions.json"));
		const agentsDir = path.join(stateDir, "agents");
		visitDirentsBounded(agentsDir, MAX_SESSION_SCAN_AGENTS, (agentEntry) => {
			if (!agentEntry.isDirectory() || scannedSessionEntries.count >= MAX_SESSION_SCAN_FILES) return;
			scanSessionDirectory({
				results,
				stateDir,
				sessionsDir: path.join(agentsDir, agentEntry.name, "sessions"),
				relativePrefix: path.posix.join("agents", agentEntry.name, "sessions"),
				seenDirs,
				scannedSessionEntries
			});
		});
		for (const storePath of sessionStorePaths) {
			if (scannedSessionEntries.count >= MAX_SESSION_SCAN_FILES) break;
			scanSessionDirectory({
				results,
				stateDir,
				sessionsDir: path.dirname(path.resolve(storePath)),
				relativePrefix: "sessions",
				seenDirs,
				scannedSessionEntries
			});
		}
	} catch {}
	const top = results.toSorted((a, b) => b.sizeBytes - a.sizeBytes || a.relativePath.localeCompare(b.relativePath)).slice(0, MAX_SESSION_FILE_RESULTS);
	return top.length > 0 ? top : void 0;
}
function buildMemoryPressureEvidence(options) {
	const stateDir = options.stateDir ?? resolveStateDir(options.env ?? process.env);
	const heapStatistics = collectHeapStatistics();
	const heapSpaces = collectHeapSpaces();
	const cgroup = collectCgroupMemorySummary();
	const activeResources = collectActiveResources();
	const topSessionFiles = collectTopSessionFiles(stateDir, options.sessionStorePaths);
	return { memoryPressure: {
		level: options.pressure.level,
		reason: options.pressure.reason,
		memory: options.pressure.memory,
		...options.pressure.thresholdBytes !== void 0 ? { thresholdBytes: options.pressure.thresholdBytes } : {},
		...options.pressure.rssGrowthBytes !== void 0 ? { rssGrowthBytes: options.pressure.rssGrowthBytes } : {},
		...options.pressure.windowMs !== void 0 ? { windowMs: options.pressure.windowMs } : {},
		...heapStatistics ? { heapStatistics } : {},
		...heapSpaces ? { heapSpaces } : {},
		...cgroup ? { cgroup } : {},
		...activeResources ? { activeResources } : {},
		...topSessionFiles ? { topSessionFiles } : {}
	} };
}
function isMemoryPressureReason(reason) {
	return reason === "rss_threshold" || reason === "heap_threshold" || reason === "rss_growth";
}
function listDiagnosticStabilityBundleFilesSync(options = {}) {
	const dir = resolveDiagnosticStabilityBundleDir(options);
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && isBundleFile(entry.name)).map((entry) => {
			const file = path.join(dir, entry.name);
			return {
				path: file,
				mtimeMs: fs.statSync(file).mtimeMs
			};
		}).toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
}
function readDiagnosticStabilityBundleFileSync(file) {
	try {
		const stat = fs.statSync(file);
		if (stat.size > 5242880) throw new Error(`Stability bundle is too large: ${stat.size} bytes exceeds ${MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES}`);
		const raw = fs.readFileSync(file, "utf8");
		const bundle = parseDiagnosticStabilityBundle(JSON.parse(raw));
		return {
			status: "found",
			path: file,
			mtimeMs: stat.mtimeMs,
			bundle
		};
	} catch (error) {
		return {
			status: "failed",
			path: file,
			error
		};
	}
}
function readLatestDiagnosticStabilityBundleSync(options = {}) {
	try {
		const latest = listDiagnosticStabilityBundleFilesSync(options)[0];
		if (!latest) return {
			status: "missing",
			dir: resolveDiagnosticStabilityBundleDir(options)
		};
		return readDiagnosticStabilityBundleFileSync(latest.path);
	} catch (error) {
		return {
			status: "failed",
			error
		};
	}
}
function pruneOldBundles(dir, retention) {
	if (!Number.isFinite(retention) || retention < 1) return;
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && isBundleFile(entry.name)).map((entry) => {
			const file = path.join(dir, entry.name);
			let mtimeMs = 0;
			try {
				mtimeMs = fs.statSync(file).mtimeMs;
			} catch {}
			return {
				file,
				mtimeMs
			};
		}).toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
		for (const entry of entries.slice(retention)) try {
			fs.unlinkSync(entry.file);
		} catch {}
	} catch {}
}
function writeDiagnosticStabilityBundleSync(options) {
	try {
		const now = options.now ?? /* @__PURE__ */ new Date();
		const snapshot = getDiagnosticStabilitySnapshot({ limit: options.limit ?? DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT });
		if (!options.includeEmpty && snapshot.count === 0) return {
			status: "skipped",
			reason: "empty"
		};
		const reason = normalizeReason(options.reason);
		const error = options.error ? readSafeErrorMetadata(options.error) : void 0;
		const bundle = {
			version: 1,
			generatedAt: now.toISOString(),
			reason,
			process: {
				pid: process.pid,
				platform: process.platform,
				arch: process.arch,
				node: process.versions.node,
				uptimeMs: Math.round(process.uptime() * 1e3)
			},
			host: { hostname: REDACTED_HOSTNAME },
			...error ? { error } : {},
			...options.evidence ? { evidence: options.evidence } : {},
			snapshot
		};
		const dir = resolveDiagnosticStabilityBundleDir(options);
		const file = buildBundlePath(dir, now, reason);
		replaceFileAtomicSync({
			filePath: file,
			content: `${JSON.stringify(bundle, null, 2)}\n`,
			dirMode: 448,
			mode: 384,
			tempPrefix: ".openclaw-stability"
		});
		pruneOldBundles(dir, options.retention ?? 20);
		return {
			status: "written",
			path: file,
			bundle
		};
	} catch (error) {
		return {
			status: "failed",
			error
		};
	}
}
function writeDiagnosticMemoryPressureBundleSync(options) {
	return writeDiagnosticStabilityBundleSync({
		...options,
		reason: "diagnostic.memory.pressure.critical",
		includeEmpty: true,
		evidence: buildMemoryPressureEvidence(options)
	});
}
function writeDiagnosticStabilityBundleForFailureSync(reason, error, options = {}) {
	const result = writeDiagnosticStabilityBundleSync({
		...options,
		reason,
		error,
		includeEmpty: true
	});
	if (result.status === "written") return {
		status: "written",
		path: result.path,
		message: `wrote stability bundle: ${result.path}`
	};
	if (result.status === "failed") return {
		status: "failed",
		error: result.error,
		message: `failed to write stability bundle: ${String(result.error)}`
	};
	return result;
}
function installDiagnosticStabilityFatalHook(options = {}) {
	if (fatalHookUnsubscribe) return;
	fatalHookUnsubscribe = registerFatalErrorHook(({ reason, error }) => {
		const result = writeDiagnosticStabilityBundleForFailureSync(reason, error, options);
		return "message" in result ? result.message : void 0;
	});
}
function uninstallDiagnosticStabilityFatalHook() {
	fatalHookUnsubscribe?.();
	fatalHookUnsubscribe = null;
}
function resetDiagnosticStabilityBundleForTest() {
	uninstallDiagnosticStabilityFatalHook();
}
//#endregion
export { installDiagnosticStabilityFatalHook as a, readLatestDiagnosticStabilityBundleSync as c, uninstallDiagnosticStabilityFatalHook as d, writeDiagnosticMemoryPressureBundleSync as f, MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES as i, resetDiagnosticStabilityBundleForTest as l, writeDiagnosticStabilityBundleSync as m, DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION as n, listDiagnosticStabilityBundleFilesSync as o, writeDiagnosticStabilityBundleForFailureSync as p, DIAGNOSTIC_STABILITY_BUNDLE_VERSION as r, readDiagnosticStabilityBundleFileSync as s, DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT as t, resolveDiagnosticStabilityBundleDir as u };
