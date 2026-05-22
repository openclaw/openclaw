import { a as resolveTrajectoryPointerFilePath, i as resolveTrajectoryFilePath, n as TRAJECTORY_RUNTIME_EVENT_MAX_BYTES, o as resolveTrajectoryPointerOpenFlags } from "./paths-CqRDOB2X.js";
import { n as sanitizeDiagnosticPayload, t as safeJsonStringify } from "./safe-json-C5WtZ6yf.js";
import { t as parseBooleanValue } from "./boolean-twwXMOfI.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region src/agents/queued-file-writer.ts
function resolveQueuedFileAppendFlags(constants = fs.constants) {
	const noFollow = constants.O_NOFOLLOW;
	return constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (typeof noFollow === "number" ? noFollow : 0);
}
async function assertNoSymlinkParents(filePath) {
	const resolvedDir = path.resolve(path.dirname(filePath));
	const parsed = path.parse(resolvedDir);
	const relativeParts = path.relative(parsed.root, resolvedDir).split(path.sep).filter(Boolean);
	let current = parsed.root;
	for (const part of relativeParts) {
		current = path.join(current, part);
		const stat = await fs$1.lstat(current);
		if (stat.isSymbolicLink()) {
			if (path.dirname(current) === parsed.root) continue;
			throw new Error(`Refusing to write queued log under symlinked directory: ${current}`);
		}
		if (!stat.isDirectory()) throw new Error(`Refusing to write queued log under non-directory: ${current}`);
	}
}
function verifyStableOpenedFile(params) {
	if (!params.postOpenStat.isFile()) throw new Error(`Refusing to write queued log to non-file: ${params.filePath}`);
	if (params.postOpenStat.nlink > 1) throw new Error(`Refusing to write queued log to hardlinked file: ${params.filePath}`);
	const pre = params.preOpenStat;
	if (pre && (pre.dev !== params.postOpenStat.dev || pre.ino !== params.postOpenStat.ino)) throw new Error(`Refusing to write queued log after file changed: ${params.filePath}`);
}
async function safeAppendFile(filePath, line, options) {
	await assertNoSymlinkParents(filePath);
	let preOpenStat;
	try {
		const stat = await fs$1.lstat(filePath);
		if (stat.isSymbolicLink()) throw new Error(`Refusing to write queued log through symlink: ${filePath}`);
		if (!stat.isFile()) throw new Error(`Refusing to write queued log to non-file: ${filePath}`);
		preOpenStat = stat;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	const lineBytes = Buffer.byteLength(line, "utf8");
	if (options.maxFileBytes !== void 0 && (preOpenStat?.size ?? 0) + lineBytes > options.maxFileBytes) return;
	const handle = await fs$1.open(filePath, resolveQueuedFileAppendFlags(), 384);
	try {
		const stat = await handle.stat();
		verifyStableOpenedFile({
			preOpenStat,
			postOpenStat: stat,
			filePath
		});
		if (options.maxFileBytes !== void 0 && stat.size + lineBytes > options.maxFileBytes) return;
		await handle.chmod(384);
		await handle.appendFile(line, "utf8");
	} finally {
		await handle.close();
	}
}
function waitForImmediate() {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}
function getQueuedFileWriter(writers, filePath, options = {}) {
	const existing = writers.get(filePath);
	if (existing) return existing;
	const dir = path.dirname(filePath);
	const ready = fs$1.mkdir(dir, {
		recursive: true,
		mode: 448
	}).catch(() => void 0);
	let queue = Promise.resolve();
	let queuedBytes = 0;
	const writer = {
		filePath,
		write: (line) => {
			const lineBytes = Buffer.byteLength(line, "utf8");
			if (options.maxQueuedBytes !== void 0 && queuedBytes + lineBytes > options.maxQueuedBytes) return "dropped";
			queuedBytes += lineBytes;
			queue = queue.then(() => ready).then(() => options.yieldBeforeWrite ? waitForImmediate() : void 0).then(() => safeAppendFile(filePath, line, options)).catch(() => void 0).finally(() => {
				queuedBytes = Math.max(0, queuedBytes - lineBytes);
			});
			return "queued";
		},
		flush: async () => {
			await queue;
		}
	};
	writers.set(filePath, writer);
	return writer;
}
//#endregion
//#region src/trajectory/runtime.ts
const writers = /* @__PURE__ */ new Map();
const MAX_TRAJECTORY_WRITERS = 100;
const TRAJECTORY_RUNTIME_TRUNCATION_SENTINEL_RESERVE_BYTES = 2048;
const TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS = 32768;
const TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS = 64;
const TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS = 64;
const TRAJECTORY_RUNTIME_DATA_MAX_DEPTH = 6;
function writeTrajectoryPointerBestEffort(params) {
	if (!params.sessionFile) return;
	const pointerPath = resolveTrajectoryPointerFilePath(params.sessionFile);
	try {
		const pointerDir = path.resolve(path.dirname(pointerPath));
		if (fs.lstatSync(pointerDir).isSymbolicLink()) return;
		try {
			if (fs.lstatSync(pointerPath).isSymbolicLink()) return;
		} catch (error) {
			if (error.code !== "ENOENT") return;
		}
		const fd = fs.openSync(pointerPath, resolveTrajectoryPointerOpenFlags(), 384);
		try {
			fs.writeFileSync(fd, `${JSON.stringify({
				traceSchema: "openclaw-trajectory-pointer",
				schemaVersion: 1,
				sessionId: params.sessionId,
				runtimeFile: params.filePath
			}, null, 2)}\n`, "utf8");
			fs.fchmodSync(fd, 384);
		} finally {
			fs.closeSync(fd);
		}
	} catch {}
}
function trimTrajectoryWriterCache() {
	while (writers.size >= MAX_TRAJECTORY_WRITERS) {
		const oldestKey = writers.keys().next().value;
		if (!oldestKey) return;
		writers.delete(oldestKey);
	}
}
function truncateOversizedTrajectoryEvent(event, line) {
	const bytes = Buffer.byteLength(line, "utf8");
	if (bytes <= 262144) return line;
	const truncated = safeJsonStringify({
		...event,
		data: {
			truncated: true,
			originalBytes: bytes,
			limitBytes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
			reason: "trajectory-event-size-limit"
		}
	});
	if (truncated && Buffer.byteLength(truncated, "utf8") <= 262144) return truncated;
}
function truncatedTrajectoryValue(reason, details = {}) {
	return {
		truncated: true,
		reason,
		...details
	};
}
function limitTrajectoryPayloadValue(value, depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
	if (typeof value === "string") {
		if (value.length > TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS) return truncatedTrajectoryValue("trajectory-field-size-limit", {
			originalChars: value.length,
			limitChars: TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS
		});
		return value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return truncatedTrajectoryValue("trajectory-circular-reference");
	if (depth >= TRAJECTORY_RUNTIME_DATA_MAX_DEPTH) return truncatedTrajectoryValue("trajectory-depth-limit", { limitDepth: TRAJECTORY_RUNTIME_DATA_MAX_DEPTH });
	seen.add(value);
	if (Array.isArray(value)) {
		const limited = value.slice(0, TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS).map((item) => limitTrajectoryPayloadValue(item, depth + 1, seen));
		if (value.length > TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS) limited.push(truncatedTrajectoryValue("trajectory-array-size-limit", {
			originalLength: value.length,
			limitItems: TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS
		}));
		seen.delete(value);
		return limited;
	}
	const record = value;
	const keys = Object.keys(record);
	const limited = {};
	for (const key of keys.slice(0, TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS)) limited[key] = limitTrajectoryPayloadValue(record[key], depth + 1, seen);
	if (keys.length > TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS) limited._truncated = truncatedTrajectoryValue("trajectory-object-size-limit", {
		originalKeys: keys.length,
		limitKeys: TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS
	});
	seen.delete(value);
	return limited;
}
function sanitizeTrajectoryPayload(data) {
	return sanitizeDiagnosticPayload(limitTrajectoryPayloadValue(data));
}
function toTrajectoryToolDefinitions(tools) {
	return tools.flatMap((tool) => {
		const name = tool.name?.trim();
		if (!name) return [];
		return [{
			name,
			description: tool.description,
			parameters: sanitizeDiagnosticPayload(limitTrajectoryPayloadValue(tool.parameters))
		}];
	}).toSorted((left, right) => left.name.localeCompare(right.name));
}
function createTrajectoryRuntimeRecorder(params) {
	const env = params.env ?? process.env;
	if (!(parseBooleanValue(env.OPENCLAW_TRAJECTORY) ?? true)) return null;
	const filePath = resolveTrajectoryFilePath({
		env,
		sessionFile: params.sessionFile,
		sessionId: params.sessionId
	});
	if (!params.writer) trimTrajectoryWriterCache();
	const maxRuntimeFileBytes = Math.max(1, Math.floor(params.maxRuntimeFileBytes ?? 10485760));
	const writer = params.writer ?? getQueuedFileWriter(writers, filePath, {
		maxFileBytes: maxRuntimeFileBytes,
		maxQueuedBytes: maxRuntimeFileBytes,
		yieldBeforeWrite: true
	});
	writeTrajectoryPointerBestEffort({
		filePath,
		sessionFile: params.sessionFile,
		sessionId: params.sessionId
	});
	let seq = 0;
	const traceId = params.sessionId;
	const sentinelReserveBytes = Math.min(TRAJECTORY_RUNTIME_TRUNCATION_SENTINEL_RESERVE_BYTES, Math.floor(maxRuntimeFileBytes / 2));
	const normalEventLimitBytes = Math.max(1, maxRuntimeFileBytes - sentinelReserveBytes);
	let acceptedRuntimeBytes = 0;
	let droppedEvents = 0;
	let droppedEventBytes = 0;
	let captureStopped = false;
	const writeBoundedLine = (line, options) => {
		const jsonlLine = `${line}\n`;
		const lineBytes = Buffer.byteLength(jsonlLine, "utf8");
		const limitBytes = options.reserveSentinel ? normalEventLimitBytes : maxRuntimeFileBytes;
		if (acceptedRuntimeBytes + lineBytes > limitBytes) {
			captureStopped = true;
			droppedEvents += 1;
			droppedEventBytes += lineBytes;
			return false;
		}
		if (writer.write(jsonlLine) === "dropped") {
			captureStopped = true;
			droppedEvents += 1;
			droppedEventBytes += lineBytes;
			return false;
		}
		acceptedRuntimeBytes += lineBytes;
		return true;
	};
	const buildEventLine = (type, data) => {
		const nextSeq = seq + 1;
		const event = {
			traceSchema: "openclaw-trajectory",
			schemaVersion: 1,
			traceId,
			source: "runtime",
			type,
			ts: (/* @__PURE__ */ new Date()).toISOString(),
			seq: nextSeq,
			sourceSeq: nextSeq,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			runId: params.runId,
			workspaceDir: params.workspaceDir,
			provider: params.provider,
			modelId: params.modelId,
			modelApi: params.modelApi,
			data: data ? sanitizeTrajectoryPayload(data) : void 0
		};
		const line = safeJsonStringify(event);
		if (!line) return;
		const boundedLine = truncateOversizedTrajectoryEvent(event, line);
		if (!boundedLine) return;
		seq = nextSeq;
		return boundedLine;
	};
	return {
		enabled: true,
		filePath,
		recordEvent: (type, data) => {
			if (captureStopped) {
				droppedEvents += 1;
				return;
			}
			const line = buildEventLine(type, data);
			if (!line) return;
			writeBoundedLine(line, { reserveSentinel: true });
		},
		flush: async () => {
			if (droppedEvents > 0) {
				const line = buildEventLine("trace.truncated", {
					reason: "trajectory-runtime-file-size-limit",
					droppedEvents,
					droppedEventBytes,
					limitBytes: maxRuntimeFileBytes
				});
				if (line) writeBoundedLine(line, { reserveSentinel: false });
				droppedEvents = 0;
				droppedEventBytes = 0;
			}
			await writer.flush();
			if (!params.writer) writers.delete(filePath);
		}
	};
}
//#endregion
export { toTrajectoryToolDefinitions as n, getQueuedFileWriter as r, createTrajectoryRuntimeRecorder as t };
