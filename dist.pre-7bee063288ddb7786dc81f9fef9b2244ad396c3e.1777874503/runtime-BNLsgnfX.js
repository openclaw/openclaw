import { a as resolveTrajectoryPointerOpenFlags, i as resolveTrajectoryPointerFilePath, r as resolveTrajectoryFilePath, t as TRAJECTORY_RUNTIME_EVENT_MAX_BYTES } from "./paths-9Bej0Y6c.js";
import { n as sanitizeDiagnosticPayload, t as safeJsonStringify } from "./safe-json-DqzLVdVG.js";
import { t as parseBooleanValue } from "./boolean-MDNs1L2v.js";
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
function getQueuedFileWriter(writers, filePath, options = {}) {
	const existing = writers.get(filePath);
	if (existing) return existing;
	const dir = path.dirname(filePath);
	const ready = fs$1.mkdir(dir, {
		recursive: true,
		mode: 448
	}).catch(() => void 0);
	let queue = Promise.resolve();
	const writer = {
		filePath,
		write: (line) => {
			queue = queue.then(() => ready).then(() => safeAppendFile(filePath, line, options)).catch(() => void 0);
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
function toTrajectoryToolDefinitions(tools) {
	return tools.flatMap((tool) => {
		const name = tool.name?.trim();
		if (!name) return [];
		return [{
			name,
			description: tool.description,
			parameters: sanitizeDiagnosticPayload(tool.parameters)
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
	const writer = params.writer ?? getQueuedFileWriter(writers, filePath, { maxFileBytes: 52428800 });
	writeTrajectoryPointerBestEffort({
		filePath,
		sessionFile: params.sessionFile,
		sessionId: params.sessionId
	});
	let seq = 0;
	const traceId = params.sessionId;
	return {
		enabled: true,
		filePath,
		recordEvent: (type, data) => {
			const event = {
				traceSchema: "openclaw-trajectory",
				schemaVersion: 1,
				traceId,
				source: "runtime",
				type,
				ts: (/* @__PURE__ */ new Date()).toISOString(),
				seq: seq += 1,
				sourceSeq: seq,
				sessionId: params.sessionId,
				sessionKey: params.sessionKey,
				runId: params.runId,
				workspaceDir: params.workspaceDir,
				provider: params.provider,
				modelId: params.modelId,
				modelApi: params.modelApi,
				data: data ? sanitizeDiagnosticPayload(data) : void 0
			};
			const line = safeJsonStringify(event);
			if (!line) return;
			const boundedLine = truncateOversizedTrajectoryEvent(event, line);
			if (!boundedLine) return;
			writer.write(`${boundedLine}\n`);
		},
		flush: async () => {
			await writer.flush();
			if (!params.writer) writers.delete(filePath);
		}
	};
}
//#endregion
export { toTrajectoryToolDefinitions as n, getQueuedFileWriter as r, createTrajectoryRuntimeRecorder as t };
