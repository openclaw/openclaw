import { n as redactSecrets } from "./redact-R2-EdHUS.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, o as resolveSessionTranscriptPath, r as resolveDefaultSessionStorePath } from "./paths-kGAxo7MN.js";
import { C as parseSessionThreadInfo, o as normalizeStoreSessionKey, t as loadSessionStore } from "./store-load-cmAGD4uk.js";
import "./store-3qAZ3Zl6.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-B00DLjg-.js";
import { n as extractAssistantVisibleText } from "./chat-message-content-Df8A1xtk.js";
import { t as resolveAndPersistSessionFile } from "./session-file-C6TQVMAx.js";
import { c as resolveSessionWriteLockAcquireTimeoutMs, r as acquireSessionWriteLock } from "./session-write-lock-BT1vMcpZ.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import readline from "node:readline";
//#region src/config/sessions/transcript-append.ts
const TRANSCRIPT_APPEND_SCAN_CHUNK_BYTES = 64 * 1024;
const SESSION_MANAGER_APPEND_MAX_BYTES = 8 * 1024 * 1024;
let piCodingAgentModulePromise$1 = null;
const transcriptAppendQueues = /* @__PURE__ */ new Map();
async function loadCurrentSessionVersion() {
	piCodingAgentModulePromise$1 ??= import("@earendil-works/pi-coding-agent");
	return (await piCodingAgentModulePromise$1).CURRENT_SESSION_VERSION;
}
async function yieldTranscriptAppendScan() {
	await new Promise((resolve) => setImmediate(resolve));
}
function lineParentLinkedEntryId(line) {
	if (!line.trim()) return;
	try {
		const parsed = JSON.parse(line);
		return parsed.type !== "session" && typeof parsed.id === "string" && "parentId" in parsed ? parsed.id : void 0;
	} catch {
		return;
	}
}
function normalizeEntryId(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function generateEntryId(existingIds) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = randomUUID().slice(0, 8);
		if (!existingIds.has(id)) {
			existingIds.add(id);
			return id;
		}
	}
	const id = randomUUID();
	existingIds.add(id);
	return id;
}
async function readTranscriptLeafInfo(transcriptPath) {
	const handle = await fs$1.open(transcriptPath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(TRANSCRIPT_APPEND_SCAN_CHUNK_BYTES);
		let carry = "";
		let leafId;
		let hasParentLinkedEntries = false;
		let nonSessionEntryCount = 0;
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead <= 0) break;
			const lines = (carry + decoder.write(buffer.subarray(0, bytesRead))).split(/\r?\n/);
			carry = lines.pop() ?? "";
			for (const line of lines) {
				if (lineHasNonSessionEntry(line)) nonSessionEntryCount += 1;
				const id = lineParentLinkedEntryId(line);
				if (id) {
					leafId = id;
					hasParentLinkedEntries = true;
				}
			}
			await yieldTranscriptAppendScan();
		}
		const tail = carry + decoder.end();
		if (lineHasNonSessionEntry(tail)) nonSessionEntryCount += 1;
		const id = lineParentLinkedEntryId(tail);
		if (id) {
			leafId = id;
			hasParentLinkedEntries = true;
		}
		return {
			...leafId ? { leafId } : {},
			hasParentLinkedEntries,
			nonSessionEntryCount
		};
	} finally {
		await handle.close();
	}
}
function lineHasNonSessionEntry(line) {
	if (!line.trim()) return false;
	try {
		return JSON.parse(line).type !== "session";
	} catch {
		return false;
	}
}
async function migrateLinearTranscriptToParentLinked(transcriptPath) {
	const raw = await fs$1.readFile(transcriptPath, "utf-8");
	const currentSessionVersion = await loadCurrentSessionVersion();
	const existingIds = /* @__PURE__ */ new Set();
	const output = [];
	let previousId = null;
	let leafId;
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			output.push(line);
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			output.push(line);
			continue;
		}
		const record = parsed;
		if (record.type === "session") {
			output.push(JSON.stringify({
				...record,
				version: currentSessionVersion
			}));
			continue;
		}
		const id = normalizeEntryId(record.id) ?? generateEntryId(existingIds);
		existingIds.add(id);
		record.id = id;
		if (!Object.hasOwn(record, "parentId")) record.parentId = previousId;
		previousId = id;
		leafId = id;
		output.push(JSON.stringify(record));
	}
	await fs$1.writeFile(transcriptPath, `${output.join("\n")}\n`, {
		encoding: "utf-8",
		mode: 384
	});
	const result = {};
	if (leafId) result.leafId = leafId;
	return result;
}
async function ensureTranscriptHeader(transcriptPath, params = {}) {
	const stat = await fs$1.stat(transcriptPath).catch(() => null);
	if (stat?.isFile() && stat.size > 0) return;
	const currentSessionVersion = await loadCurrentSessionVersion();
	await fs$1.mkdir(path.dirname(transcriptPath), { recursive: true });
	const header = {
		type: "session",
		version: currentSessionVersion,
		id: params.sessionId ?? randomUUID(),
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		cwd: params.cwd ?? process.cwd()
	};
	await fs$1.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, {
		encoding: "utf-8",
		mode: 384,
		flag: stat?.isFile() ? "w" : "wx"
	});
}
async function resolveTranscriptAppendQueueKey(transcriptPath) {
	const resolvedTranscriptPath = path.resolve(transcriptPath);
	const transcriptDir = path.dirname(resolvedTranscriptPath);
	await fs$1.mkdir(transcriptDir, { recursive: true });
	try {
		return path.join(await fs$1.realpath(transcriptDir), path.basename(resolvedTranscriptPath));
	} catch {
		return resolvedTranscriptPath;
	}
}
async function withTranscriptAppendQueue(transcriptPath, fn) {
	const queueKey = await resolveTranscriptAppendQueueKey(transcriptPath);
	const previous = transcriptAppendQueues.get(queueKey) ?? Promise.resolve();
	let releaseCurrent;
	const current = new Promise((resolve) => {
		releaseCurrent = resolve;
	});
	const tail = previous.catch(() => void 0).then(() => current);
	transcriptAppendQueues.set(queueKey, tail);
	await previous.catch(() => void 0);
	try {
		return await fn();
	} finally {
		releaseCurrent();
		if (transcriptAppendQueues.get(queueKey) === tail) transcriptAppendQueues.delete(queueKey);
	}
}
async function appendSessionTranscriptMessage(params) {
	return await withTranscriptAppendQueue(params.transcriptPath, () => appendSessionTranscriptMessageLocked(params));
}
async function appendSessionTranscriptMessageLocked(params) {
	const lock = await acquireSessionWriteLock({
		sessionFile: params.transcriptPath,
		timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config),
		allowReentrant: true
	});
	try {
		const now = params.now ?? Date.now();
		const messageId = randomUUID();
		await ensureTranscriptHeader(params.transcriptPath, {
			...params.sessionId ? { sessionId: params.sessionId } : {},
			...params.cwd ? { cwd: params.cwd } : {}
		});
		const stat = await fs$1.stat(params.transcriptPath).catch(() => null);
		let leafInfo = await readTranscriptLeafInfo(params.transcriptPath).catch(() => ({
			hasParentLinkedEntries: false,
			nonSessionEntryCount: 0
		}));
		const hasLinearEntries = !leafInfo.hasParentLinkedEntries && leafInfo.nonSessionEntryCount > 0;
		const shouldRawAppend = params.useRawWhenLinear !== false && hasLinearEntries && (stat?.size ?? 0) > SESSION_MANAGER_APPEND_MAX_BYTES;
		if (hasLinearEntries && !shouldRawAppend) {
			const migrated = await migrateLinearTranscriptToParentLinked(params.transcriptPath);
			leafInfo = {
				...migrated.leafId ? { leafId: migrated.leafId } : {},
				hasParentLinkedEntries: Boolean(migrated.leafId),
				nonSessionEntryCount: leafInfo.nonSessionEntryCount
			};
		}
		const entry = {
			type: "message",
			id: messageId,
			...shouldRawAppend ? {} : { parentId: leafInfo.leafId ?? null },
			timestamp: new Date(now).toISOString(),
			message: redactSecrets(params.message)
		};
		await fs$1.appendFile(params.transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
		return { messageId };
	} finally {
		await lock.release();
	}
}
//#endregion
//#region src/config/sessions/transcript-mirror.ts
function stripQuery(value) {
	const noHash = value.split("#")[0] ?? value;
	return noHash.split("?")[0] ?? noHash;
}
function extractFileNameFromMediaUrl(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const cleaned = stripQuery(trimmed);
	try {
		const parsed = new URL(cleaned);
		const base = path.basename(parsed.pathname);
		if (!base) return null;
		try {
			return decodeURIComponent(base);
		} catch {
			return base;
		}
	} catch {
		const base = path.basename(cleaned);
		if (!base || base === "/" || base === ".") return null;
		return base;
	}
}
function resolveMirroredTranscriptText(params) {
	const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
	if (mediaUrls.length > 0) {
		const names = mediaUrls.map((url) => extractFileNameFromMediaUrl(url)).filter((name) => Boolean(name && name.trim()));
		if (names.length > 0) return names.join(", ");
		return "media";
	}
	const trimmed = (params.text ?? "").trim();
	return trimmed ? trimmed : null;
}
//#endregion
//#region src/config/sessions/transcript-stream.ts
const DEFAULT_REVERSE_CHUNK_BYTES = 64 * 1024;
const MAX_REVERSE_CHUNK_BYTES = 1024 * 1024;
const MIN_REVERSE_CHUNK_BYTES = 1024;
/**
* Stream the non-empty, trimmed JSONL lines of a transcript file in order.
*
* Returns an empty async iterator if the file does not exist, is empty, or is
* not a regular file. Honours `options.signal` between lines so long scans can
* cooperate with abort signals.
*/
async function* streamSessionTranscriptLines(filePath, options = {}) {
	let stat;
	try {
		stat = await fs.promises.stat(filePath);
	} catch {
		return;
	}
	if (!stat.isFile() || stat.size <= 0) return;
	if (options.signal?.aborted) return;
	const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
	const rl = readline.createInterface({
		input: stream,
		crlfDelay: Infinity
	});
	try {
		for await (const line of rl) {
			if (options.signal?.aborted) return;
			const trimmed = line.trim();
			if (!trimmed) continue;
			yield trimmed;
		}
	} finally {
		rl.close();
		stream.destroy();
	}
}
/**
* Stream the non-empty, trimmed JSONL lines of a transcript file in reverse
* (newest-first) order.
*
* Returns an empty async iterator if the file cannot be opened, is empty, or is
* not a regular file. The implementation splits on newline bytes before UTF-8
* decoding so multibyte characters survive arbitrary chunk boundaries.
*/
async function* streamSessionTranscriptLinesReverse(filePath, options = {}) {
	const requestedChunkBytes = Number.isFinite(options.chunkBytes) ? Math.max(MIN_REVERSE_CHUNK_BYTES, Math.floor(options.chunkBytes)) : DEFAULT_REVERSE_CHUNK_BYTES;
	const chunkBytes = Math.min(requestedChunkBytes, MAX_REVERSE_CHUNK_BYTES);
	let fileHandle;
	try {
		fileHandle = await fs.promises.open(filePath, "r");
	} catch {
		return;
	}
	try {
		const stat = await fileHandle.stat();
		if (!stat.isFile() || stat.size <= 0 || options.signal?.aborted) return;
		let position = stat.size;
		let carry = Buffer.alloc(0);
		while (position > 0) {
			if (options.signal?.aborted) return;
			const readLength = Math.min(position, chunkBytes);
			position -= readLength;
			const chunk = await readFileRangeAsync(fileHandle, position, readLength);
			const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
			let lineEnd = combined.length;
			for (let index = combined.length - 1; index >= 0; index -= 1) {
				if (combined[index] !== 10) continue;
				const line = decodeTrimmedLine(combined.subarray(index + 1, lineEnd));
				if (line) {
					yield line;
					if (options.signal?.aborted) return;
				}
				lineEnd = index;
			}
			carry = combined.subarray(0, lineEnd);
		}
		const firstLine = decodeTrimmedLine(carry);
		if (firstLine && !options.signal?.aborted) yield firstLine;
	} finally {
		await fileHandle.close().catch(() => void 0);
	}
}
function decodeTrimmedLine(line) {
	return line.toString("utf-8").trim();
}
async function readFileRangeAsync(fileHandle, position, length) {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
		if (bytesRead <= 0) break;
		offset += bytesRead;
	}
	return offset === length ? buffer : buffer.subarray(0, offset);
}
//#endregion
//#region src/config/sessions/transcript.ts
let piCodingAgentModulePromise = null;
async function loadPiCodingAgentModule() {
	piCodingAgentModulePromise ??= import("@earendil-works/pi-coding-agent");
	return await piCodingAgentModulePromise;
}
async function ensureSessionHeader(params) {
	if (fs.existsSync(params.sessionFile)) return;
	const { CURRENT_SESSION_VERSION } = await loadPiCodingAgentModule();
	await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: params.sessionId,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		cwd: process.cwd()
	};
	await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
		encoding: "utf-8",
		mode: 384
	});
}
function parseAssistantTranscriptText(line) {
	const parsed = JSON.parse(line);
	const message = parsed.message;
	if (!message || message.role !== "assistant") return;
	const text = extractAssistantVisibleText(message)?.trim();
	if (!text) return;
	return {
		...typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {},
		text,
		...typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}
	};
}
async function resolveSessionTranscriptFile(params) {
	const sessionPathOpts = resolveSessionFilePathOptions({
		agentId: params.agentId,
		storePath: params.storePath
	});
	let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
	let sessionEntry = params.sessionEntry;
	if (params.sessionStore && params.storePath) {
		const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
		const fallbackSessionFile = !sessionEntry?.sessionFile ? resolveSessionTranscriptPath(params.sessionId, params.agentId, params.threadId ?? threadIdFromSessionKey) : void 0;
		const resolvedSessionFile = await resolveAndPersistSessionFile({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			sessionStore: params.sessionStore,
			storePath: params.storePath,
			sessionEntry,
			agentId: sessionPathOpts?.agentId,
			sessionsDir: sessionPathOpts?.sessionsDir,
			fallbackSessionFile
		});
		sessionFile = resolvedSessionFile.sessionFile;
		sessionEntry = resolvedSessionFile.sessionEntry;
	}
	return {
		sessionFile,
		sessionEntry
	};
}
async function readLatestAssistantTextFromSessionTranscript(sessionFile) {
	if (!sessionFile?.trim()) return;
	for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) try {
		const assistantText = parseAssistantTranscriptText(line);
		if (assistantText) return assistantText;
	} catch {
		continue;
	}
}
async function readTailAssistantTextFromSessionTranscript(sessionFile) {
	if (!sessionFile?.trim()) return;
	for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) try {
		return parseAssistantTranscriptText(line);
	} catch {
		return;
	}
}
async function appendAssistantMessageToSessionTranscript(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) return {
		ok: false,
		reason: "missing sessionKey"
	};
	const mirrorText = resolveMirroredTranscriptText({
		text: params.text,
		mediaUrls: params.mediaUrls
	});
	if (!mirrorText) return {
		ok: false,
		reason: "empty text"
	};
	return appendExactAssistantMessageToSessionTranscript({
		agentId: params.agentId,
		sessionKey,
		storePath: params.storePath,
		idempotencyKey: params.idempotencyKey,
		updateMode: params.updateMode,
		config: params.config,
		message: {
			role: "assistant",
			content: [{
				type: "text",
				text: mirrorText
			}],
			api: "openai-responses",
			provider: "openclaw",
			model: "delivery-mirror",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: "stop",
			timestamp: Date.now()
		}
	});
}
async function appendExactAssistantMessageToSessionTranscript(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) return {
		ok: false,
		reason: "missing sessionKey"
	};
	if (params.message.role !== "assistant") return {
		ok: false,
		reason: "message role must be assistant"
	};
	const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
	const store = loadSessionStore(storePath, { skipCache: true });
	const entry = store[normalizeStoreSessionKey(sessionKey)] ?? store[sessionKey];
	if (!entry?.sessionId) return {
		ok: false,
		reason: `unknown sessionKey: ${sessionKey}`
	};
	let sessionFile;
	try {
		sessionFile = (await resolveAndPersistSessionFile({
			sessionId: entry.sessionId,
			sessionKey,
			sessionStore: store,
			storePath,
			sessionEntry: entry,
			agentId: params.agentId,
			sessionsDir: path.dirname(storePath)
		})).sessionFile;
	} catch (err) {
		return {
			ok: false,
			reason: formatErrorMessage(err)
		};
	}
	await ensureSessionHeader({
		sessionFile,
		sessionId: entry.sessionId
	});
	const explicitIdempotencyKey = params.idempotencyKey ?? params.message.idempotencyKey;
	const existingMessageId = explicitIdempotencyKey ? await transcriptHasIdempotencyKey(sessionFile, explicitIdempotencyKey) : void 0;
	if (existingMessageId) return {
		ok: true,
		sessionFile,
		messageId: existingMessageId === true ? explicitIdempotencyKey ?? "" : existingMessageId
	};
	const latestEquivalentAssistantId = isRedundantDeliveryMirror(params.message) ? await findLatestEquivalentAssistantMessageId(sessionFile, params.message) : void 0;
	if (latestEquivalentAssistantId) return {
		ok: true,
		sessionFile,
		messageId: latestEquivalentAssistantId
	};
	const message = {
		...params.message,
		...explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}
	};
	const { messageId } = await appendSessionTranscriptMessage({
		transcriptPath: sessionFile,
		message,
		config: params.config
	});
	switch (params.updateMode ?? "inline") {
		case "inline":
			emitSessionTranscriptUpdate({
				sessionFile,
				sessionKey,
				message,
				messageId
			});
			break;
		case "file-only":
			emitSessionTranscriptUpdate({
				sessionFile,
				sessionKey
			});
			break;
		case "none": break;
	}
	return {
		ok: true,
		sessionFile,
		messageId
	};
}
async function transcriptHasIdempotencyKey(transcriptPath, idempotencyKey) {
	try {
		for await (const line of streamSessionTranscriptLines(transcriptPath)) try {
			const parsed = JSON.parse(line);
			if (parsed.message?.idempotencyKey === idempotencyKey && typeof parsed.id === "string" && parsed.id) return parsed.id;
			if (parsed.message?.idempotencyKey === idempotencyKey) return true;
		} catch {
			continue;
		}
	} catch {
		return;
	}
}
function isRedundantDeliveryMirror(message) {
	return message.provider === "openclaw" && message.model === "delivery-mirror";
}
function extractAssistantMessageText(message) {
	if (!Array.isArray(message.content)) return null;
	const parts = message.content.filter((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0).map((part) => part.text.trim());
	return parts.length > 0 ? parts.join("\n").trim() : null;
}
async function findLatestEquivalentAssistantMessageId(transcriptPath, message) {
	const expectedText = extractAssistantMessageText(message);
	if (!expectedText) return;
	for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) try {
		const parsed = JSON.parse(line);
		const candidate = parsed.message;
		if (!candidate || candidate.role !== "assistant") continue;
		if (extractAssistantMessageText(candidate) !== expectedText) return;
		if (typeof parsed.id === "string" && parsed.id) return parsed.id;
		return;
	} catch {
		continue;
	}
}
//#endregion
export { resolveSessionTranscriptFile as a, appendSessionTranscriptMessage as c, readTailAssistantTextFromSessionTranscript as i, appendExactAssistantMessageToSessionTranscript as n, streamSessionTranscriptLines as o, readLatestAssistantTextFromSessionTranscript as r, resolveMirroredTranscriptText as s, appendAssistantMessageToSessionTranscript as t };
