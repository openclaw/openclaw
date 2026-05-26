import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString$1, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as hasInterSessionUserProvenance } from "./input-provenance-CmqYxlZ2.js";
import { n as extractAssistantVisibleText } from "./chat-message-content-DN9xEd6w.js";
import { u as stripInternalRuntimeContext } from "./internal-runtime-context-DWxvZFcB.js";
import { n as stripInboundMetadata, t as extractInboundSenderLabel } from "./strip-inbound-meta-D2-__BeH.js";
import { i as hasNonzeroUsage, o as normalizeUsage, r as deriveSessionTotalTokens } from "./usage-DKNTRfvn.js";
import { n as estimateTokensFromChars, t as estimateStringChars } from "./cjk-chars-BtjJDifS.js";
import { i as stripInlineDirectiveTagsForDisplay } from "./directive-tags-CClLEtM7.js";
import { a as resolveSessionTranscriptCandidates } from "./session-transcript-files.fs-CDIpA7EV.js";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
//#region src/shared/chat-envelope.ts
const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
	"WebChat",
	"WhatsApp",
	"Telegram",
	"Signal",
	"Slack",
	"Discord",
	"Google Chat",
	"iMessage",
	"Teams",
	"Matrix",
	"Zalo",
	"Zalo Personal",
	"iMessage"
];
const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;
function looksLikeEnvelopeHeader(header) {
	if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) return true;
	if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) return true;
	return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}
function stripEnvelope(text) {
	const match = text.match(ENVELOPE_PREFIX);
	if (!match) return text;
	if (!looksLikeEnvelopeHeader(match[1] ?? "")) return text;
	return text.slice(match[0].length);
}
function stripMessageIdHints(text) {
	if (!/\[message_id:/i.test(text)) return text;
	const lines = text.split(/\r?\n/);
	const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
	return filtered.length === lines.length ? text : filtered.join("\n");
}
//#endregion
//#region src/auto-reply/reply/display-text-sanitize.ts
function stripInternalMetadataForDisplay(text) {
	return stripInboundMetadata(stripInternalRuntimeContext(text));
}
function stripUserEnvelopeForDisplay(text) {
	return stripMessageIdHints(stripEnvelope(stripInternalMetadataForDisplay(text)));
}
//#endregion
//#region src/infra/json-utf8-bytes.ts
function jsonUtf8Bytes(value) {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return Buffer.byteLength(String(value), "utf8");
	}
}
function jsonUtf8BytesOrInfinity(value) {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : Number.POSITIVE_INFINITY;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}
function jsonStringByteLengthUpToLimit(value, remainingBytes) {
	if (value.length + 2 > remainingBytes) return remainingBytes + 1;
	return jsonUtf8BytesOrInfinity(value);
}
function* enumerableOwnEntries(value) {
	const record = value;
	for (const key in record) if (Object.prototype.propertyIsEnumerable.call(record, key)) yield [key, record[key]];
}
function firstEnumerableOwnKeys(value, maxKeys) {
	const keys = [];
	for (const key in value) {
		if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
		keys.push(key);
		if (keys.length >= maxKeys) break;
	}
	return keys;
}
function boundedJsonUtf8Bytes(value, maxBytes) {
	let bytes = 0;
	const seen = /* @__PURE__ */ new WeakSet();
	const add = (amount) => {
		bytes += amount;
		if (bytes > maxBytes) throw new Error("json_byte_limit_exceeded");
	};
	const visit = (entry, inArray) => {
		if (entry === null) {
			add(4);
			return;
		}
		switch (typeof entry) {
			case "string":
				add(jsonStringByteLengthUpToLimit(entry, maxBytes - bytes));
				return;
			case "number":
				add(jsonUtf8BytesOrInfinity(Number.isFinite(entry) ? entry : null));
				return;
			case "boolean":
				add(entry ? 4 : 5);
				return;
			case "undefined":
			case "function":
			case "symbol":
				if (inArray) add(4);
				return;
			case "bigint": throw new Error("json_byte_length_unsupported");
			case "object": break;
		}
		const objectEntry = entry;
		if (seen.has(objectEntry)) throw new Error("json_byte_length_circular");
		if (typeof objectEntry.toJSON === "function" && !(objectEntry instanceof Date)) throw new Error("json_byte_length_custom_to_json");
		seen.add(objectEntry);
		try {
			if (objectEntry instanceof Date) {
				visit(objectEntry.toJSON(), inArray);
				return;
			}
			if (Array.isArray(objectEntry)) {
				add(1);
				for (let index = 0; index < objectEntry.length; index += 1) {
					if (index > 0) add(1);
					visit(objectEntry[index], true);
				}
				add(1);
				return;
			}
			add(1);
			let wroteField = false;
			for (const [key, field] of enumerableOwnEntries(objectEntry)) {
				if (field === void 0 || typeof field === "function" || typeof field === "symbol") continue;
				if (wroteField) add(1);
				wroteField = true;
				add(jsonStringByteLengthUpToLimit(key, maxBytes - bytes));
				add(1);
				visit(field, false);
			}
			add(1);
		} finally {
			seen.delete(objectEntry);
		}
	};
	try {
		visit(value, false);
		return {
			bytes,
			complete: true
		};
	} catch {
		return {
			bytes: Math.max(bytes, maxBytes + 1),
			complete: false
		};
	}
}
//#endregion
//#region src/utils/transcript-tools.ts
const TOOL_CALL_TYPES = new Set([
	"tool_use",
	"toolcall",
	"tool_call"
]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "tool_result_error"]);
const normalizeType = (value) => {
	return typeof value === "string" ? normalizeOptionalLowercaseString(value) ?? "" : "";
};
const extractToolCallNames = (message) => {
	const names = /* @__PURE__ */ new Set();
	const toolNameRaw = message.toolName ?? message.tool_name;
	const toolName = typeof toolNameRaw === "string" ? normalizeOptionalString$1(toolNameRaw) : void 0;
	if (toolName) names.add(toolName);
	const content = message.content;
	if (!Array.isArray(content)) return Array.from(names);
	for (const entry of content) {
		if (!entry || typeof entry !== "object") continue;
		const block = entry;
		const type = normalizeType(block.type);
		if (!TOOL_CALL_TYPES.has(type)) continue;
		const name = typeof block.name === "string" ? normalizeOptionalString$1(block.name) : void 0;
		if (name) names.add(name);
	}
	return Array.from(names);
};
const hasToolCall = (message) => extractToolCallNames(message).length > 0;
const countToolResults = (message) => {
	const content = message.content;
	if (!Array.isArray(content)) return {
		total: 0,
		errors: 0
	};
	let total = 0;
	let errors = 0;
	for (const entry of content) {
		if (!entry || typeof entry !== "object") continue;
		const block = entry;
		const type = normalizeType(block.type);
		if (!TOOL_RESULT_TYPES.has(type)) continue;
		total += 1;
		if (block.is_error === true) errors += 1;
	}
	return {
		total,
		errors
	};
};
//#endregion
//#region src/gateway/chat-sanitize.ts
function extractMessageSenderLabel(entry) {
	if (typeof entry.senderLabel === "string" && entry.senderLabel.trim()) return entry.senderLabel.trim();
	if (typeof entry.content === "string") return extractInboundSenderLabel(entry.content);
	if (Array.isArray(entry.content)) for (const item of entry.content) {
		if (!item || typeof item !== "object") continue;
		const text = item.text;
		if (typeof text !== "string") continue;
		const senderLabel = extractInboundSenderLabel(text);
		if (senderLabel) return senderLabel;
	}
	if (typeof entry.text === "string") return extractInboundSenderLabel(entry.text);
	return null;
}
function stripEnvelopeFromContentWithRole(content, stripUserEnvelope) {
	let changed = false;
	return {
		content: content.map((item) => {
			if (!item || typeof item !== "object") return item;
			const entry = item;
			if (entry.type !== "text" || typeof entry.text !== "string") return item;
			const stripped = stripUserEnvelope ? stripUserEnvelopeForDisplay(entry.text) : stripInternalMetadataForDisplay(entry.text);
			if (stripped === entry.text) return item;
			changed = true;
			return {
				...entry,
				text: stripped
			};
		}),
		changed
	};
}
function stripEnvelopeFromMessage(message) {
	if (!message || typeof message !== "object") return message;
	const entry = message;
	const stripUserEnvelope = (typeof entry.role === "string" ? normalizeLowercaseStringOrEmpty(entry.role) : "") === "user";
	let changed = false;
	const next = { ...entry };
	const senderLabel = stripUserEnvelope ? extractMessageSenderLabel(entry) : null;
	if (senderLabel && entry.senderLabel !== senderLabel) {
		next.senderLabel = senderLabel;
		changed = true;
	}
	if (typeof entry.content === "string") {
		const stripped = stripUserEnvelope ? stripUserEnvelopeForDisplay(entry.content) : stripInternalMetadataForDisplay(entry.content);
		if (stripped !== entry.content) {
			next.content = stripped;
			changed = true;
		}
	} else if (Array.isArray(entry.content)) {
		const updated = stripEnvelopeFromContentWithRole(entry.content, stripUserEnvelope);
		if (updated.changed) {
			next.content = updated.content;
			changed = true;
		}
	} else if (typeof entry.text === "string") {
		const stripped = stripUserEnvelope ? stripUserEnvelopeForDisplay(entry.text) : stripInternalMetadataForDisplay(entry.text);
		if (stripped !== entry.text) {
			next.text = stripped;
			changed = true;
		}
	}
	return changed ? next : message;
}
function stripEnvelopeFromMessages(messages) {
	if (messages.length === 0) return messages;
	let changed = false;
	const next = messages.map((message) => {
		const stripped = stripEnvelopeFromMessage(message);
		if (stripped !== message) changed = true;
		return stripped;
	});
	return changed ? next : messages;
}
//#endregion
//#region src/gateway/session-transcript-index.fs.ts
const TRANSCRIPT_INDEX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_INDEX_CACHE_ENTRIES = 256;
const transcriptIndexCache = /* @__PURE__ */ new Map();
const transcriptIndexBuilds = /* @__PURE__ */ new Map();
function normalizeOptionalString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
async function yieldTranscriptIndexScan() {
	await new Promise((resolve) => setImmediate(resolve));
}
function touchCachedIndex(filePath, entry) {
	transcriptIndexCache.delete(filePath);
	transcriptIndexCache.set(filePath, entry);
	return entry.index;
}
function setCachedIndex(filePath, entry) {
	transcriptIndexCache.set(filePath, entry);
	while (transcriptIndexCache.size > MAX_TRANSCRIPT_INDEX_CACHE_ENTRIES) {
		const oldestKey = transcriptIndexCache.keys().next().value;
		if (typeof oldestKey !== "string" || !oldestKey) break;
		transcriptIndexCache.delete(oldestKey);
	}
}
function isIndexableTranscriptRecord(record) {
	return Boolean(record && typeof record === "object" && !Array.isArray(record));
}
function isVisibleTranscriptRecord(record) {
	return Boolean(record.message) || record.type === "compaction";
}
function isTreeTranscriptRecord(record) {
	return record.type !== "session" && typeof record.id === "string" && "parentId" in record;
}
async function visitTranscriptJsonLines(filePath, visit) {
	const handle = await fs.promises.open(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(TRANSCRIPT_INDEX_READ_CHUNK_BYTES);
		let carry = "";
		let carryOffset = 0;
		let nextOffset = 0;
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead <= 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			const lines = (carry + decoder.write(chunk)).split("\n");
			carry = lines.pop() ?? "";
			let lineOffset = carryOffset;
			for (const rawLine of lines) {
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				const byteLength = Buffer.byteLength(line, "utf8");
				visit(line, lineOffset, byteLength);
				lineOffset += Buffer.byteLength(rawLine, "utf8") + 1;
			}
			nextOffset += bytesRead;
			carryOffset = nextOffset - Buffer.byteLength(carry, "utf8");
			await yieldTranscriptIndexScan();
		}
		const tail = carry + decoder.end();
		if (tail) {
			const line = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
			visit(line, carryOffset, Buffer.byteLength(line, "utf8"));
		}
	} finally {
		await handle.close();
	}
}
function buildActiveTreeEntries(params) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	let currentId = params.leafId;
	while (currentId) {
		if (seen.has(currentId)) return [];
		seen.add(currentId);
		const entry = params.byId.get(currentId);
		if (!entry) break;
		out.push(entry);
		currentId = entry.parentId ?? void 0;
	}
	return out.toReversed();
}
function toIndexedEntries(rawEntries) {
	const entries = [];
	let seq = 0;
	for (const entry of rawEntries) {
		if (!isVisibleTranscriptRecord(entry.record)) continue;
		seq += 1;
		entries.push({
			seq,
			...entry.id ? { id: entry.id } : {},
			offset: entry.offset,
			byteLength: entry.byteLength,
			record: entry.record
		});
	}
	return entries;
}
async function buildSessionTranscriptIndex(filePath, stat) {
	const rawEntries = [];
	const byId = /* @__PURE__ */ new Map();
	let hasTreeEntries = false;
	let leafId;
	await visitTranscriptJsonLines(filePath, (line, offset, byteLength) => {
		if (!line.trim()) return;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isIndexableTranscriptRecord(parsed)) return;
		const id = normalizeOptionalString(parsed.id);
		const parentId = parsed.parentId === null ? null : normalizeOptionalString(parsed.parentId) ?? void 0;
		const rawEntry = {
			...id ? { id } : {},
			...parentId !== void 0 ? { parentId } : {},
			offset,
			byteLength,
			record: parsed
		};
		rawEntries.push(rawEntry);
		if (id) {
			byId.set(id, rawEntry);
			if (isTreeTranscriptRecord(parsed)) {
				hasTreeEntries = true;
				leafId = id;
			}
		}
	});
	const activeRawEntries = hasTreeEntries ? buildActiveTreeEntries({
		byId,
		leafId
	}) : rawEntries;
	return {
		filePath,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		hasTreeEntries,
		...leafId ? { leafId } : {},
		entries: toIndexedEntries(activeRawEntries)
	};
}
async function readSessionTranscriptIndex(filePath) {
	let stat;
	try {
		stat = await fs.promises.stat(filePath);
	} catch {
		transcriptIndexCache.delete(filePath);
		return null;
	}
	if (!stat.isFile()) {
		transcriptIndexCache.delete(filePath);
		return null;
	}
	const cached = transcriptIndexCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return touchCachedIndex(filePath, cached);
	const inFlight = transcriptIndexBuilds.get(filePath);
	if (inFlight && inFlight.mtimeMs === stat.mtimeMs && inFlight.size === stat.size) return await inFlight.promise;
	const promise = buildSessionTranscriptIndex(filePath, stat);
	transcriptIndexBuilds.set(filePath, {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		promise
	});
	const index = await promise.finally(() => {
		if (transcriptIndexBuilds.get(filePath)?.promise === promise) transcriptIndexBuilds.delete(filePath);
	});
	setCachedIndex(filePath, {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		index
	});
	return index;
}
//#endregion
//#region src/gateway/session-utils.fs.ts
const sessionTitleFieldsCache = /* @__PURE__ */ new Map();
const MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES = 5e3;
const transcriptMessageCountCache = /* @__PURE__ */ new Map();
const MAX_TRANSCRIPT_MESSAGE_COUNT_CACHE_ENTRIES = 5e3;
function readSessionTitleFieldsCacheKey(filePath, opts) {
	return `${filePath}\t${opts?.includeInterSession === true ? "1" : "0"}`;
}
function getCachedSessionTitleFields(cacheKey, stat) {
	const cached = sessionTitleFieldsCache.get(cacheKey);
	if (!cached) return null;
	if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
		sessionTitleFieldsCache.delete(cacheKey);
		return null;
	}
	sessionTitleFieldsCache.delete(cacheKey);
	sessionTitleFieldsCache.set(cacheKey, cached);
	return {
		firstUserMessage: cached.firstUserMessage,
		lastMessagePreview: cached.lastMessagePreview
	};
}
function setCachedSessionTitleFields(cacheKey, stat, value) {
	sessionTitleFieldsCache.set(cacheKey, {
		...value,
		mtimeMs: stat.mtimeMs,
		size: stat.size
	});
	while (sessionTitleFieldsCache.size > MAX_SESSION_TITLE_FIELDS_CACHE_ENTRIES) {
		const oldestKey = sessionTitleFieldsCache.keys().next().value;
		if (typeof oldestKey !== "string" || !oldestKey) break;
		sessionTitleFieldsCache.delete(oldestKey);
	}
}
function getCachedTranscriptMessageCount(filePath, stat) {
	const cached = transcriptMessageCountCache.get(filePath);
	if (!cached) return null;
	if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
		transcriptMessageCountCache.delete(filePath);
		return null;
	}
	transcriptMessageCountCache.delete(filePath);
	transcriptMessageCountCache.set(filePath, cached);
	return cached.count;
}
function setCachedTranscriptMessageCount(filePath, stat, count) {
	transcriptMessageCountCache.set(filePath, {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		count
	});
	while (transcriptMessageCountCache.size > MAX_TRANSCRIPT_MESSAGE_COUNT_CACHE_ENTRIES) {
		const oldestKey = transcriptMessageCountCache.keys().next().value;
		if (typeof oldestKey !== "string" || !oldestKey) break;
		transcriptMessageCountCache.delete(oldestKey);
	}
}
function attachOpenClawTranscriptMeta(message, meta) {
	if (!message || typeof message !== "object" || Array.isArray(message)) return message;
	const record = message;
	const existing = record["__openclaw"] && typeof record["__openclaw"] === "object" && !Array.isArray(record["__openclaw"]) ? record["__openclaw"] : {};
	return {
		...record,
		__openclaw: {
			...existing,
			...meta
		}
	};
}
const RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
async function readRecentTranscriptTailLinesAsync(filePath, stat, opts) {
	const maxMessages = Math.max(0, Math.floor(opts.maxMessages));
	const maxBytes = Math.max(1024, Math.floor(opts.maxBytes ?? RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES));
	const readLen = Math.min(stat.size, maxBytes);
	const readStart = Math.max(0, stat.size - readLen);
	const maxLines = Math.max(maxMessages, Math.floor(opts.maxLines ?? maxMessages * 20 + 20));
	const handle = await fs.promises.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(readLen);
		const { bytesRead } = await handle.read(buffer, 0, readLen, readStart);
		if (bytesRead <= 0) return [];
		return buffer.toString("utf-8", 0, bytesRead).split(/\r?\n/).slice(readStart > 0 ? 1 : 0).filter((line) => line.trim().length > 0).slice(-maxLines);
	} finally {
		await handle.close();
	}
}
const MAX_TRANSCRIPT_PARSE_LINE_BYTES = 256 * 1024;
const OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS = 64 * 1024;
const TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER = "[chat.history omitted: message too large]";
function isOversizedTranscriptLine(line) {
	return Buffer.byteLength(line, "utf8") > MAX_TRANSCRIPT_PARSE_LINE_BYTES;
}
function extractJsonStringFieldPrefix(prefix, field) {
	const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(prefix);
	if (!match) return;
	try {
		return normalizeTailEntryString(JSON.parse(`"${match[1]}"`));
	} catch {
		return;
	}
}
function extractJsonNullableStringFieldPrefix(prefix, field) {
	if (new RegExp(`"${field}"\\s*:\\s*null`).test(prefix)) return null;
	return extractJsonStringFieldPrefix(prefix, field);
}
function buildOversizedTranscriptRecord(line) {
	const prefix = line.slice(0, OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS);
	const id = extractJsonStringFieldPrefix(prefix, "id");
	const parentId = extractJsonNullableStringFieldPrefix(prefix, "parentId");
	const type = extractJsonStringFieldPrefix(prefix, "type");
	const role = extractJsonStringFieldPrefix(prefix, "role") ?? "assistant";
	const record = {
		...type ? { type } : {},
		...id ? { id } : {},
		...parentId !== void 0 ? { parentId } : {},
		message: {
			role,
			content: [{
				type: "text",
				text: TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER
			}],
			__openclaw: {
				truncated: true,
				reason: "oversized"
			}
		}
	};
	return {
		...id ? { id } : {},
		...parentId !== void 0 ? { parentId } : {},
		record
	};
}
function normalizeTailEntryString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function parseTailTranscriptRecord(line) {
	if (isOversizedTranscriptLine(line)) return buildOversizedTranscriptRecord(line);
	try {
		const parsed = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed;
		return {
			...normalizeTailEntryString(record.id) ? { id: normalizeTailEntryString(record.id) } : {},
			...record.parentId === null ? { parentId: null } : normalizeTailEntryString(record.parentId) ? { parentId: normalizeTailEntryString(record.parentId) } : {},
			record
		};
	} catch {
		return null;
	}
}
function tailRecordHasTreeLink(entry) {
	return entry.record.type !== "session" && typeof entry.id === "string" && Object.hasOwn(entry.record, "parentId");
}
function selectBoundedActiveTailRecords(entries) {
	const byId = /* @__PURE__ */ new Map();
	let leafId;
	for (const entry of entries) {
		if (entry.id) byId.set(entry.id, entry);
		if (tailRecordHasTreeLink(entry) && entry.id) leafId = entry.id;
	}
	if (!leafId) return entries;
	const selected = [];
	const seen = /* @__PURE__ */ new Set();
	let currentId = leafId;
	while (currentId) {
		if (seen.has(currentId)) return [];
		seen.add(currentId);
		const entry = byId.get(currentId);
		if (!entry) break;
		selected.push(entry);
		currentId = entry.parentId ?? void 0;
	}
	const activeBranch = selected.toReversed();
	const firstActiveRecord = activeBranch[0];
	const firstActiveIndex = firstActiveRecord ? entries.indexOf(firstActiveRecord) : -1;
	if (firstActiveIndex > 0) for (let index = firstActiveIndex - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.record.type === "compaction") return [entry, ...activeBranch];
	}
	return activeBranch;
}
function selectActiveTranscriptRecords(records) {
	return records.some(tailRecordHasTreeLink) ? selectBoundedActiveTailRecords(records) : records;
}
function transcriptRecordsToMessages(records) {
	const messages = [];
	let messageSeq = 0;
	for (const entry of records) {
		const message = parsedSessionEntryToMessage(entry.record, messageSeq + 1);
		if (message) {
			messageSeq += 1;
			messages.push(message);
		}
	}
	return messages;
}
function parseRecentTranscriptTailMessages(lines, maxMessages) {
	return transcriptRecordsToMessages(selectActiveTranscriptRecords(lines.flatMap((line) => {
		const entry = parseTailTranscriptRecord(line);
		return entry ? [entry] : [];
	}))).slice(-maxMessages);
}
function visitTranscriptLines(filePath, visit) {
	const fd = fs.openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let carry = "";
		while (true) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead <= 0) break;
			const lines = (carry + decoder.write(buffer.subarray(0, bytesRead))).split(/\r?\n/);
			carry = lines.pop() ?? "";
			for (const line of lines) visit(line);
		}
		const tail = carry + decoder.end();
		if (tail) visit(tail);
	} finally {
		fs.closeSync(fd);
	}
}
async function readSessionMessagesAsync(sessionId, storePath, sessionFile, opts) {
	if (opts.mode === "recent") {
		const { mode: modeValue, ...recentOpts } = opts;
		return await readRecentSessionMessagesAsync(sessionId, storePath, sessionFile, recentOpts);
	}
	const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
	if (!filePath) return [];
	return (await readSessionTranscriptIndex(filePath))?.entries.flatMap((entry) => indexedTranscriptEntryToMessages(entry)) ?? [];
}
async function visitSessionMessagesAsync(sessionId, storePath, sessionFile, visit, _opts) {
	const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
	if (!filePath) return 0;
	const index = await readSessionTranscriptIndex(filePath);
	if (!index) return 0;
	for (const entry of index.entries) {
		const message = indexedTranscriptEntryToMessage(entry);
		if (message) visit(message, entry.seq);
	}
	return index.entries.length;
}
async function readSessionMessageCountAsync(sessionId, storePath, sessionFile) {
	const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
	if (!filePath) return 0;
	let stat = null;
	try {
		stat = await fs.promises.stat(filePath);
		const cached = getCachedTranscriptMessageCount(filePath, stat);
		if (typeof cached === "number") return cached;
	} catch {}
	const count = (await readSessionTranscriptIndex(filePath))?.entries.length ?? 0;
	if (stat) setCachedTranscriptMessageCount(filePath, stat, count);
	return count;
}
async function readRecentSessionMessagesAsync(sessionId, storePath, sessionFile, opts) {
	const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
	if (maxMessages === 0) return [];
	const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile);
	if (!filePath) return [];
	let stat;
	try {
		stat = await fs.promises.stat(filePath);
	} catch {
		return [];
	}
	if (stat.size === 0) return [];
	return parseRecentTranscriptTailMessages(await readRecentTranscriptTailLinesAsync(filePath, stat, {
		...opts,
		maxMessages
	}), maxMessages);
}
async function readRecentSessionMessagesWithStatsAsync(sessionId, storePath, sessionFile, opts) {
	const totalMessages = await readSessionMessageCountAsync(sessionId, storePath, sessionFile);
	const messages = await readRecentSessionMessagesAsync(sessionId, storePath, sessionFile, opts);
	const firstSeq = Math.max(1, totalMessages - messages.length + 1);
	return {
		messages: messages.map((message, index) => attachOpenClawTranscriptMeta(message, { seq: firstSeq + index })),
		totalMessages
	};
}
function readRecentSessionTranscriptLines(params) {
	const filePath = findExistingTranscriptPath(params.sessionId, params.storePath, params.sessionFile, params.agentId);
	if (!filePath) return null;
	const maxLines = Math.max(1, Math.floor(params.maxLines));
	const lines = [];
	let totalLines = 0;
	try {
		visitTranscriptLines(filePath, (line) => {
			if (!line.trim()) return;
			totalLines += 1;
			lines.push(line);
			if (lines.length > maxLines) lines.shift();
		});
	} catch {
		return null;
	}
	return {
		lines,
		totalLines
	};
}
function parsedSessionEntryToMessage(parsed, seq) {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const entry = parsed;
	if (entry.message) return attachOpenClawTranscriptMeta(entry.message, {
		...typeof entry.id === "string" ? { id: entry.id } : {},
		seq
	});
	if (entry.type === "compaction") {
		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		return {
			role: "system",
			content: [{
				type: "text",
				text: "Compaction"
			}],
			timestamp: Number.isFinite(ts) ? ts : Date.now(),
			__openclaw: {
				kind: "compaction",
				id: typeof entry.id === "string" ? entry.id : void 0,
				seq
			}
		};
	}
	return null;
}
function indexedTranscriptEntryToMessage(entry) {
	return parsedSessionEntryToMessage(entry.record, entry.seq);
}
function indexedTranscriptEntryToMessages(entry) {
	const message = indexedTranscriptEntryToMessage(entry);
	return message ? [message] : [];
}
function capArrayByJsonBytes(items, maxBytes) {
	if (items.length === 0) return {
		items,
		bytes: 2
	};
	const parts = items.map((item) => jsonUtf8Bytes(item));
	let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
	let start = 0;
	while (bytes > maxBytes && start < items.length - 1) {
		bytes -= parts[start] + 1;
		start += 1;
	}
	return {
		items: start > 0 ? items.slice(start) : items,
		bytes
	};
}
const MAX_LINES_TO_SCAN = 10;
function readSessionTitleFieldsFromTranscript(sessionId, storePath, sessionFile, agentId, opts) {
	const filePath = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId).find((p) => fs.existsSync(p));
	if (!filePath) return {
		firstUserMessage: null,
		lastMessagePreview: null
	};
	let stat;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return {
			firstUserMessage: null,
			lastMessagePreview: null
		};
	}
	const cacheKey = readSessionTitleFieldsCacheKey(filePath, opts);
	const cached = getCachedSessionTitleFields(cacheKey, stat);
	if (cached) return cached;
	if (stat.size === 0) {
		const empty = {
			firstUserMessage: null,
			lastMessagePreview: null
		};
		setCachedSessionTitleFields(cacheKey, stat, empty);
		return empty;
	}
	let fd = null;
	try {
		fd = fs.openSync(filePath, "r");
		const size = stat.size;
		let firstUserMessage = null;
		try {
			const chunk = readTranscriptHeadChunk(fd);
			if (chunk) firstUserMessage = extractFirstUserMessageFromTranscriptChunk(chunk, opts);
		} catch {}
		let lastMessagePreview = null;
		try {
			lastMessagePreview = readLastMessagePreviewFromOpenTranscript({
				fd,
				size
			});
		} catch {}
		const result = {
			firstUserMessage,
			lastMessagePreview
		};
		setCachedSessionTitleFields(cacheKey, stat, result);
		return result;
	} catch {
		return {
			firstUserMessage: null,
			lastMessagePreview: null
		};
	} finally {
		if (fd !== null) try {
			fs.closeSync(fd);
		} catch {}
	}
}
async function readSessionTitleFieldsFromTranscriptAsync(sessionId, storePath, sessionFile, agentId, opts) {
	const filePath = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId).find((p) => fs.existsSync(p));
	if (!filePath) return {
		firstUserMessage: null,
		lastMessagePreview: null
	};
	let stat;
	try {
		stat = await fs.promises.stat(filePath);
	} catch {
		return {
			firstUserMessage: null,
			lastMessagePreview: null
		};
	}
	const cacheKey = readSessionTitleFieldsCacheKey(filePath, opts);
	const cached = getCachedSessionTitleFields(cacheKey, stat);
	if (cached) return cached;
	if (stat.size === 0) {
		const empty = {
			firstUserMessage: null,
			lastMessagePreview: null
		};
		setCachedSessionTitleFields(cacheKey, stat, empty);
		return empty;
	}
	let handle = null;
	try {
		handle = await fs.promises.open(filePath, "r");
		let firstUserMessage = null;
		try {
			const chunk = await readTranscriptHeadChunkAsync(handle);
			if (chunk) firstUserMessage = extractFirstUserMessageFromTranscriptChunk(chunk, opts);
		} catch {}
		let lastMessagePreview = null;
		try {
			lastMessagePreview = await readLastMessagePreviewFromOpenTranscriptAsync({
				handle,
				size: stat.size
			});
		} catch {}
		const result = {
			firstUserMessage,
			lastMessagePreview
		};
		setCachedSessionTitleFields(cacheKey, stat, result);
		return result;
	} catch {
		return {
			firstUserMessage: null,
			lastMessagePreview: null
		};
	} finally {
		if (handle) await handle.close().catch(() => void 0);
	}
}
function extractTextFromContent(content) {
	if (typeof content === "string") return stripInlineDirectiveTagsForDisplay(content).text.trim() || null;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (!part || typeof part.text !== "string") continue;
		if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
			const normalized = stripInlineDirectiveTagsForDisplay(part.text).text.trim();
			if (normalized) return normalized;
		}
	}
	return null;
}
function readTranscriptHeadChunk(fd, maxBytes = 8192) {
	const buf = Buffer.alloc(maxBytes);
	const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
	if (bytesRead <= 0) return null;
	return buf.toString("utf-8", 0, bytesRead);
}
async function readTranscriptHeadChunkAsync(handle, maxBytes = 8192) {
	const buffer = Buffer.alloc(maxBytes);
	const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
	if (bytesRead <= 0) return null;
	return buffer.toString("utf-8", 0, bytesRead);
}
function extractFirstUserMessageFromTranscriptChunk(chunk, opts) {
	const lines = chunk.split(/\r?\n/).slice(0, MAX_LINES_TO_SCAN);
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const msg = JSON.parse(line)?.message;
			if (msg?.role !== "user") continue;
			if (opts?.includeInterSession !== true && hasInterSessionUserProvenance(msg)) continue;
			const text = extractTextFromContent(msg.content);
			if (text) return text;
		} catch {}
	}
	return null;
}
function findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId) {
	return resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId).find((p) => fs.existsSync(p)) ?? null;
}
function withOpenTranscriptFd(filePath, read) {
	let fd = null;
	try {
		fd = fs.openSync(filePath, "r");
		return read(fd);
	} catch {} finally {
		if (fd !== null) fs.closeSync(fd);
	}
	return null;
}
const LAST_MSG_MAX_BYTES = 16384;
function readLastMessagePreviewFromOpenTranscript(params) {
	const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
	const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
	const buf = Buffer.alloc(readLen);
	fs.readSync(params.fd, buf, 0, readLen, readStart);
	const tailLines = buf.toString("utf-8").split(/\r?\n/).filter((l) => l.trim()).slice(-20);
	for (let i = tailLines.length - 1; i >= 0; i--) {
		const line = tailLines[i];
		try {
			const msg = JSON.parse(line)?.message;
			if (msg?.role !== "user" && msg?.role !== "assistant") continue;
			const text = extractTextFromContent(msg.content);
			if (text) return text;
		} catch {}
	}
	return null;
}
async function readLastMessagePreviewFromOpenTranscriptAsync(params) {
	const readStart = Math.max(0, params.size - LAST_MSG_MAX_BYTES);
	const readLen = Math.min(params.size, LAST_MSG_MAX_BYTES);
	const buffer = Buffer.alloc(readLen);
	const { bytesRead } = await params.handle.read(buffer, 0, readLen, readStart);
	if (bytesRead <= 0) return null;
	const tailLines = buffer.toString("utf-8", 0, bytesRead).split(/\r?\n/).filter((line) => line.trim()).slice(-20);
	for (let i = tailLines.length - 1; i >= 0; i--) {
		const line = tailLines[i];
		try {
			const msg = JSON.parse(line)?.message;
			if (msg?.role !== "user" && msg?.role !== "assistant") continue;
			const text = extractTextFromContent(msg.content);
			if (text) return text;
		} catch {}
	}
	return null;
}
function extractTranscriptUsageCost(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const cost = raw.cost;
	if (!cost || typeof cost !== "object" || Array.isArray(cost)) return;
	const total = cost.total;
	return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : void 0;
}
function resolvePositiveUsageNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function extractTranscriptContentEstimatedChars(content) {
	if (typeof content === "string") {
		const normalized = stripInlineDirectiveTagsForDisplay(content).text.trim();
		return normalized ? estimateStringChars(normalized) : 0;
	}
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (!part || typeof part !== "object" || Array.isArray(part)) continue;
		const record = part;
		if (typeof record.text !== "string") continue;
		const type = typeof record.type === "string" ? record.type : "text";
		if (type !== "text" && type !== "output_text" && type !== "input_text") continue;
		const normalized = stripInlineDirectiveTagsForDisplay(record.text).text.trim();
		if (normalized) chars += estimateStringChars(normalized);
	}
	return chars;
}
function extractTranscriptTokenEstimateFromLine(line) {
	if (isOversizedTranscriptLine(line)) return null;
	try {
		const parsed = JSON.parse(line);
		const message = parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message) ? parsed.message : void 0;
		if (!message) return null;
		const role = typeof message.role === "string" ? message.role : void 0;
		if (role !== "user" && role !== "assistant") return null;
		const modelProvider = typeof message.provider === "string" ? message.provider.trim() : typeof parsed.provider === "string" ? parsed.provider.trim() : void 0;
		const model = typeof message.model === "string" ? message.model.trim() : typeof parsed.model === "string" ? parsed.model.trim() : void 0;
		if (role === "assistant" && modelProvider === "openclaw" && model === "delivery-mirror") return null;
		const contentChars = extractTranscriptContentEstimatedChars(message.content);
		if (contentChars <= 0) return null;
		return {
			estimatedChars: contentChars,
			hasModelIdentity: role === "assistant" && Boolean(modelProvider || model)
		};
	} catch {
		return null;
	}
}
function extractUsageSnapshotFromTranscriptLine(line) {
	if (isOversizedTranscriptLine(line)) return null;
	try {
		const parsed = JSON.parse(line);
		const message = parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message) ? parsed.message : void 0;
		if (!message) return null;
		const role = typeof message.role === "string" ? message.role : void 0;
		if (role && role !== "assistant") return null;
		const usageRaw = message.usage && typeof message.usage === "object" && !Array.isArray(message.usage) ? message.usage : parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage) ? parsed.usage : void 0;
		const usage = normalizeUsage(usageRaw);
		const totalTokens = resolvePositiveUsageNumber(deriveSessionTotalTokens({ usage }));
		const costUsd = extractTranscriptUsageCost(usageRaw);
		const modelProvider = typeof message.provider === "string" ? message.provider.trim() : typeof parsed.provider === "string" ? parsed.provider.trim() : void 0;
		const model = typeof message.model === "string" ? message.model.trim() : typeof parsed.model === "string" ? parsed.model.trim() : void 0;
		const isDeliveryMirror = modelProvider === "openclaw" && model === "delivery-mirror";
		const hasMeaningfulUsage = hasNonzeroUsage(usage) || typeof totalTokens === "number" || typeof costUsd === "number" && Number.isFinite(costUsd);
		if (!hasMeaningfulUsage && !Boolean(modelProvider || model)) return null;
		if (isDeliveryMirror && !hasMeaningfulUsage) return null;
		const snapshot = {};
		if (!isDeliveryMirror) {
			if (modelProvider) snapshot.modelProvider = modelProvider;
			if (model) snapshot.model = model;
		}
		if (typeof usage?.input === "number" && Number.isFinite(usage.input)) snapshot.inputTokens = usage.input;
		if (typeof usage?.output === "number" && Number.isFinite(usage.output)) snapshot.outputTokens = usage.output;
		if (typeof usage?.cacheRead === "number" && Number.isFinite(usage.cacheRead)) snapshot.cacheRead = usage.cacheRead;
		if (typeof usage?.cacheWrite === "number" && Number.isFinite(usage.cacheWrite)) snapshot.cacheWrite = usage.cacheWrite;
		if (typeof totalTokens === "number") {
			snapshot.totalTokens = totalTokens;
			snapshot.totalTokensFresh = true;
		}
		if (typeof costUsd === "number" && Number.isFinite(costUsd)) snapshot.costUsd = costUsd;
		return snapshot;
	} catch {
		return null;
	}
}
function extractAggregateUsageFromTranscriptLines(lines) {
	const snapshot = {};
	let sawSnapshot = false;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let sawInputTokens = false;
	let sawOutputTokens = false;
	let sawCacheRead = false;
	let sawCacheWrite = false;
	let costUsdTotal = 0;
	let sawCost = false;
	let estimatedTranscriptChars = 0;
	let sawEstimatedTranscriptContent = false;
	let sawEstimateModelIdentity = false;
	for (const line of lines) {
		const estimate = extractTranscriptTokenEstimateFromLine(line);
		if (estimate) {
			estimatedTranscriptChars += estimate.estimatedChars;
			sawEstimatedTranscriptContent = true;
			sawEstimateModelIdentity ||= estimate.hasModelIdentity;
		}
		const current = extractUsageSnapshotFromTranscriptLine(line);
		if (!current) continue;
		sawSnapshot = true;
		if (current.modelProvider) snapshot.modelProvider = current.modelProvider;
		if (current.model) snapshot.model = current.model;
		if (typeof current.inputTokens === "number") {
			inputTokens += current.inputTokens;
			sawInputTokens = true;
		}
		if (typeof current.outputTokens === "number") {
			outputTokens += current.outputTokens;
			sawOutputTokens = true;
		}
		if (typeof current.cacheRead === "number") {
			cacheRead += current.cacheRead;
			sawCacheRead = true;
		}
		if (typeof current.cacheWrite === "number") {
			cacheWrite += current.cacheWrite;
			sawCacheWrite = true;
		}
		if (typeof current.totalTokens === "number") {
			snapshot.totalTokens = current.totalTokens;
			snapshot.totalTokensFresh = true;
		}
		if (typeof current.costUsd === "number" && Number.isFinite(current.costUsd)) {
			costUsdTotal += current.costUsd;
			sawCost = true;
		}
	}
	if (!sawSnapshot) return null;
	if (sawInputTokens) snapshot.inputTokens = inputTokens;
	if (sawOutputTokens) snapshot.outputTokens = outputTokens;
	if (sawCacheRead) snapshot.cacheRead = cacheRead;
	if (sawCacheWrite) snapshot.cacheWrite = cacheWrite;
	if (sawCost) snapshot.costUsd = costUsdTotal;
	if (typeof snapshot.totalTokens !== "number" && sawEstimatedTranscriptContent && sawEstimateModelIdentity) {
		const estimatedTotalTokens = estimateTokensFromChars(estimatedTranscriptChars);
		if (estimatedTotalTokens > 0) {
			snapshot.totalTokens = estimatedTotalTokens;
			snapshot.totalTokensFresh = true;
		}
	}
	return snapshot;
}
function extractLatestUsageFromTranscriptLines(lines) {
	let latest = null;
	for (const line of lines) latest = extractUsageSnapshotFromTranscriptLine(line) ?? latest;
	return latest;
}
function extractAggregateUsageFromTranscriptChunk(chunk) {
	return extractAggregateUsageFromTranscriptLines(chunk.split(/\r?\n/).filter((line) => line.trim().length > 0));
}
async function readLatestRecentSessionUsageFromTranscriptAsync(sessionId, storePath, sessionFile, agentId, maxBytes) {
	const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
	if (!filePath) return null;
	try {
		const stat = await fs.promises.stat(filePath);
		if (stat.size === 0) return null;
		return extractLatestUsageFromTranscriptLines(await readRecentTranscriptTailLinesAsync(filePath, stat, {
			maxMessages: 1,
			maxLines: 1e3,
			maxBytes
		}));
	} catch {
		return null;
	}
}
function readRecentSessionUsageFromTranscript(sessionId, storePath, sessionFile, agentId, maxBytes) {
	const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
	if (!filePath) return null;
	return withOpenTranscriptFd(filePath, (fd) => {
		const stat = fs.fstatSync(fd);
		if (stat.size === 0) return null;
		const readLen = Math.min(stat.size, Math.max(1024, Math.floor(maxBytes)));
		const readStart = Math.max(0, stat.size - readLen);
		const buf = Buffer.alloc(readLen);
		const bytesRead = fs.readSync(fd, buf, 0, readLen, readStart);
		if (bytesRead <= 0) return null;
		return extractAggregateUsageFromTranscriptChunk(buf.toString("utf-8", 0, bytesRead).split(/\r?\n/).slice(readStart > 0 ? 1 : 0).join("\n"));
	});
}
const PREVIEW_READ_SIZES = [
	64 * 1024,
	256 * 1024,
	1024 * 1024
];
function normalizeRole(role, isTool) {
	if (isTool) return "tool";
	switch (normalizeLowercaseStringOrEmpty(role)) {
		case "user": return "user";
		case "assistant": return "assistant";
		case "system": return "system";
		case "tool": return "tool";
		default: return "other";
	}
}
function truncatePreviewText(text, maxChars) {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
}
function extractPreviewText(message) {
	if (normalizeLowercaseStringOrEmpty(message.role) === "assistant") {
		const assistantText = extractAssistantVisibleText(message);
		if (assistantText) {
			const normalized = stripInlineDirectiveTagsForDisplay(assistantText).text.trim();
			return normalized ? normalized : null;
		}
		return null;
	}
	if (typeof message.content === "string") {
		const normalized = stripInlineDirectiveTagsForDisplay(message.content).text.trim();
		return normalized ? normalized : null;
	}
	if (Array.isArray(message.content)) {
		const parts = message.content.map((entry) => typeof entry?.text === "string" ? stripInlineDirectiveTagsForDisplay(entry.text).text : "").filter((text) => text.trim().length > 0);
		if (parts.length > 0) return parts.join("\n").trim();
	}
	if (typeof message.text === "string") {
		const normalized = stripInlineDirectiveTagsForDisplay(message.text).text.trim();
		return normalized ? normalized : null;
	}
	return null;
}
function isToolCall(message) {
	return hasToolCall(message);
}
function extractToolNames(message) {
	return extractToolCallNames(message);
}
function extractMediaSummary(message) {
	if (!Array.isArray(message.content)) return null;
	for (const entry of message.content) {
		const raw = normalizeLowercaseStringOrEmpty(entry?.type);
		if (!raw || raw === "text" || raw === "toolcall" || raw === "tool_call") continue;
		return `[${raw}]`;
	}
	return null;
}
function buildPreviewItems(messages, maxItems, maxChars) {
	const items = [];
	for (const message of messages) {
		const toolCall = isToolCall(message);
		const role = normalizeRole(message.role, toolCall);
		let text = extractPreviewText(message);
		if (!text) {
			const toolNames = extractToolNames(message);
			if (toolNames.length > 0) {
				const shown = toolNames.slice(0, 2);
				const overflow = toolNames.length - shown.length;
				text = `call ${shown.join(", ")}`;
				if (overflow > 0) text += ` +${overflow}`;
			}
		}
		if (!text) text = extractMediaSummary(message);
		if (!text) continue;
		let trimmed = text.trim();
		if (!trimmed) continue;
		if (role === "user") trimmed = stripEnvelope(trimmed);
		trimmed = truncatePreviewText(trimmed, maxChars);
		items.push({
			role,
			text: trimmed
		});
	}
	if (items.length <= maxItems) return items;
	return items.slice(-maxItems);
}
function readRecentMessagesFromTranscript(filePath, maxMessages, readBytes) {
	let fd = null;
	try {
		fd = fs.openSync(filePath, "r");
		const size = fs.fstatSync(fd).size;
		if (size === 0) return [];
		const readStart = Math.max(0, size - readBytes);
		const readLen = Math.min(size, readBytes);
		const buf = Buffer.alloc(readLen);
		fs.readSync(fd, buf, 0, readLen, readStart);
		const tailLines = buf.toString("utf-8").split(/\r?\n/).filter((l) => l.trim()).slice(-200);
		const collected = [];
		for (let i = tailLines.length - 1; i >= 0; i--) {
			const line = tailLines[i];
			try {
				const msg = JSON.parse(line)?.message;
				if (msg && typeof msg === "object") {
					collected.push(msg);
					if (collected.length >= maxMessages) break;
				}
			} catch {}
		}
		return collected.toReversed();
	} catch {
		return [];
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
}
function readSessionPreviewItemsFromTranscript(sessionId, storePath, sessionFile, agentId, maxItems, maxChars) {
	const filePath = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId).find((p) => fs.existsSync(p));
	if (!filePath) return [];
	const boundedItems = Math.max(1, Math.min(maxItems, 50));
	const boundedChars = Math.max(20, Math.min(maxChars, 2e3));
	for (const readSize of PREVIEW_READ_SIZES) {
		const messages = readRecentMessagesFromTranscript(filePath, boundedItems, readSize);
		if (messages.length > 0 || readSize === PREVIEW_READ_SIZES[PREVIEW_READ_SIZES.length - 1]) return buildPreviewItems(messages, boundedItems, boundedChars);
	}
	return [];
}
//#endregion
export { stripInternalMetadataForDisplay as C, jsonUtf8BytesOrInfinity as S, stripMessageIdHints as T, countToolResults as _, readRecentSessionMessagesWithStatsAsync as a, firstEnumerableOwnKeys as b, readSessionMessageCountAsync as c, readSessionTitleFieldsFromTranscript as d, readSessionTitleFieldsFromTranscriptAsync as f, stripEnvelopeFromMessages as g, stripEnvelopeFromMessage as h, readRecentSessionMessagesAsync as i, readSessionMessagesAsync as l, readSessionTranscriptIndex as m, capArrayByJsonBytes as n, readRecentSessionTranscriptLines as o, visitSessionMessagesAsync as p, readLatestRecentSessionUsageFromTranscriptAsync as r, readRecentSessionUsageFromTranscript as s, attachOpenClawTranscriptMeta as t, readSessionPreviewItemsFromTranscript as u, extractToolCallNames as v, stripEnvelope as w, jsonUtf8Bytes as x, boundedJsonUtf8Bytes as y };
