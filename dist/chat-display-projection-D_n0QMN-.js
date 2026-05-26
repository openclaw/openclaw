import { s as normalizeInputProvenance } from "./input-provenance-CmqYxlZ2.js";
import { a as parseAssistantTextSignature, s as resolveAssistantMessagePhase } from "./chat-message-content-DN9xEd6w.js";
import "./internal-runtime-context-DWxvZFcB.js";
import { g as stripEnvelopeFromMessages } from "./session-utils.fs-CsnHXIqH.js";
import { i as stripInlineDirectiveTagsForDisplay } from "./directive-tags-CClLEtM7.js";
import { n as HEARTBEAT_PROMPT } from "./heartbeat-6oYmHVVQ.js";
import { n as isHeartbeatOkResponse, r as isHeartbeatUserMessage } from "./heartbeat-filter-Crwj3kBD.js";
import { n as isSuppressedControlReplyText } from "./control-reply-text-CL8TBl4o.js";
import { createHash } from "node:crypto";
//#region src/gateway/chat-display-projection.ts
const DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8e3;
function resolveEffectiveChatHistoryMaxChars(cfg, maxChars) {
	if (typeof maxChars === "number") return maxChars;
	if (typeof cfg.gateway?.webchat?.chatHistoryMaxChars === "number") return cfg.gateway.webchat.chatHistoryMaxChars;
	return DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
}
function truncateChatHistoryText(text, maxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS) {
	if (text.length <= maxChars) return {
		text,
		truncated: false
	};
	return {
		text: `${text.slice(0, maxChars)}\n...(truncated)...`,
		truncated: true
	};
}
function isToolHistoryBlockType(type) {
	if (typeof type !== "string") return false;
	const normalized = type.trim().toLowerCase();
	return normalized === "toolcall" || normalized === "tool_call" || normalized === "tooluse" || normalized === "tool_use" || normalized === "toolresult" || normalized === "tool_result";
}
function sanitizeChatHistoryContentBlock(block, opts) {
	if (!block || typeof block !== "object") return {
		block,
		changed: false
	};
	const entry = { ...block };
	let changed = false;
	const preserveExactToolPayload = opts?.preserveExactToolPayload === true || isToolHistoryBlockType(entry.type);
	const maxChars = opts?.maxChars ?? 8e3;
	if (typeof entry.text === "string") {
		const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
		if (preserveExactToolPayload) {
			entry.text = stripped.text;
			changed ||= stripped.changed;
		} else {
			const res = truncateChatHistoryText(stripped.text, maxChars);
			entry.text = res.text;
			changed ||= stripped.changed || res.truncated;
		}
	}
	if (typeof entry.content === "string") {
		const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
		if (preserveExactToolPayload) {
			entry.content = stripped.text;
			changed ||= stripped.changed;
		} else {
			const res = truncateChatHistoryText(stripped.text, maxChars);
			entry.content = res.text;
			changed ||= stripped.changed || res.truncated;
		}
	}
	if (typeof entry.partialJson === "string" && !preserveExactToolPayload) {
		const res = truncateChatHistoryText(entry.partialJson, maxChars);
		entry.partialJson = res.text;
		changed ||= res.truncated;
	}
	if (typeof entry.arguments === "string" && !preserveExactToolPayload) {
		const res = truncateChatHistoryText(entry.arguments, maxChars);
		entry.arguments = res.text;
		changed ||= res.truncated;
	}
	if (typeof entry.thinking === "string") {
		const res = truncateChatHistoryText(entry.thinking, maxChars);
		entry.thinking = res.text;
		changed ||= res.truncated;
	}
	if ("thinkingSignature" in entry) {
		delete entry.thinkingSignature;
		changed = true;
	}
	if ("openclawReasoningReplay" in entry) {
		delete entry.openclawReasoningReplay;
		changed = true;
	}
	const type = typeof entry.type === "string" ? entry.type : "";
	if (type === "image" && typeof entry.data === "string") {
		const bytes = Buffer.byteLength(entry.data, "utf8");
		delete entry.data;
		entry.omitted = true;
		entry.bytes = bytes;
		changed = true;
	}
	if (type === "audio" && entry.source && typeof entry.source === "object") {
		const source = { ...entry.source };
		if (source.type === "base64" && typeof source.data === "string") {
			const bytes = Buffer.byteLength(source.data, "utf8");
			delete source.data;
			source.omitted = true;
			source.bytes = bytes;
			entry.source = source;
			changed = true;
		}
	}
	return {
		block: changed ? entry : block,
		changed
	};
}
function sanitizeAssistantPhasedContentBlocks(content) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		const entry = block;
		return entry.type === "text" && Boolean(parseAssistantTextSignature(entry.textSignature)?.phase);
	})) return {
		content,
		changed: false
	};
	const filtered = content.filter((block) => {
		if (!block || typeof block !== "object") return true;
		const entry = block;
		if (entry.type !== "text") return true;
		return parseAssistantTextSignature(entry.textSignature)?.phase === "final_answer";
	});
	return {
		content: filtered,
		changed: filtered.length !== content.length
	};
}
function projectAssistantTextFromMixedToolContent(content, maxChars) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isToolHistoryBlockType(block.type);
	})) return null;
	const textBlocks = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
		const truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
		if (truncated.text.trim()) textBlocks.push({
			type: "text",
			text: truncated.text
		});
	}
	return textBlocks.length > 0 ? {
		content: textBlocks,
		changed: true
	} : null;
}
function toFiniteNumber(x) {
	return typeof x === "number" && Number.isFinite(x) ? x : void 0;
}
function sanitizeCost(raw) {
	if (!raw || typeof raw !== "object") return;
	const total = toFiniteNumber(raw.total);
	return total !== void 0 ? { total } : void 0;
}
function sanitizeUsage(raw) {
	if (!raw || typeof raw !== "object") return;
	const u = raw;
	const out = {};
	for (const k of [
		"input",
		"output",
		"total",
		"totalTokens",
		"inputTokens",
		"outputTokens",
		"promptTokens",
		"completionTokens",
		"cacheRead",
		"cacheWrite",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
		"input_tokens",
		"output_tokens",
		"prompt_tokens",
		"completion_tokens",
		"total_tokens"
	]) {
		const n = toFiniteNumber(u[k]);
		if (n !== void 0) out[k] = n;
	}
	if ("cost" in u && u.cost != null && typeof u.cost === "object") {
		const sanitizedCost = sanitizeCost(u.cost);
		if (sanitizedCost) out.cost = sanitizedCost;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
function sanitizeChatHistoryMessage(message, maxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS) {
	if (!message || typeof message !== "object") return {
		message,
		changed: false
	};
	const entry = { ...message };
	let changed = false;
	const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
	const preserveExactToolPayload = role === "toolresult" || role === "tool_result" || role === "tool" || role === "function" || typeof entry.toolName === "string" || typeof entry.tool_name === "string" || typeof entry.toolCallId === "string" || typeof entry.tool_call_id === "string";
	if ("details" in entry) {
		delete entry.details;
		changed = true;
	}
	if (entry.role !== "assistant") {
		if ("usage" in entry) {
			delete entry.usage;
			changed = true;
		}
		if ("cost" in entry) {
			delete entry.cost;
			changed = true;
		}
	} else {
		if ("usage" in entry) {
			const sanitized = sanitizeUsage(entry.usage);
			if (sanitized) entry.usage = sanitized;
			else delete entry.usage;
			changed = true;
		}
		if ("cost" in entry) {
			const sanitized = sanitizeCost(entry.cost);
			if (sanitized) entry.cost = sanitized;
			else delete entry.cost;
			changed = true;
		}
	}
	if (typeof entry.content === "string") {
		const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
		if (preserveExactToolPayload) {
			entry.content = stripped.text;
			changed ||= stripped.changed;
		} else {
			const res = truncateChatHistoryText(stripped.text, maxChars);
			entry.content = res.text;
			changed ||= stripped.changed || res.truncated;
		}
	} else if (Array.isArray(entry.content)) {
		const updated = entry.content.map((block) => sanitizeChatHistoryContentBlock(block, {
			preserveExactToolPayload,
			maxChars
		}));
		if (updated.some((item) => item.changed)) {
			entry.content = updated.map((item) => item.block);
			changed = true;
		}
		if (entry.role === "assistant" && Array.isArray(entry.content)) {
			const mixedToolText = projectAssistantTextFromMixedToolContent(entry.content, maxChars);
			if (mixedToolText) {
				entry.content = mixedToolText.content;
				if (entry.phase === "commentary") delete entry.phase;
				changed = true;
			} else {
				const sanitizedPhases = sanitizeAssistantPhasedContentBlocks(entry.content);
				if (sanitizedPhases.changed) {
					entry.content = sanitizedPhases.content;
					changed = true;
				}
			}
		}
	}
	if (typeof entry.text === "string") {
		const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
		if (preserveExactToolPayload) {
			entry.text = stripped.text;
			changed ||= stripped.changed;
		} else {
			const res = truncateChatHistoryText(stripped.text, maxChars);
			entry.text = res.text;
			changed ||= stripped.changed || res.truncated;
		}
	}
	return {
		message: changed ? entry : message,
		changed
	};
}
function extractAssistantTextForSilentCheck(message) {
	if (!message || typeof message !== "object") return;
	const entry = message;
	if (entry.role !== "assistant") return;
	if (typeof entry.text === "string") return entry.text;
	if (typeof entry.content === "string") return entry.content;
	if (!Array.isArray(entry.content) || entry.content.length === 0) return;
	const texts = [];
	for (const block of entry.content) {
		if (!block || typeof block !== "object") return;
		const typed = block;
		if (typed.type !== "text" || typeof typed.text !== "string") return;
		texts.push(typed.text);
	}
	return texts.length > 0 ? texts.join("\n") : void 0;
}
function hasAssistantNonTextContent(message) {
	if (!message || typeof message !== "object") return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => block && typeof block === "object" && block.type !== "text");
}
function hasAssistantMixedToolVisibleText(message) {
	if (!message || typeof message !== "object") return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	let hasToolHistoryBlock = false;
	let hasText = false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (isToolHistoryBlockType(entry.type)) hasToolHistoryBlock = true;
		if (entry.type === "text" && typeof entry.text === "string" && entry.text.trim()) hasText = true;
	}
	return hasToolHistoryBlock && hasText;
}
function normalizeOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeToolHistoryType(value) {
	const normalized = normalizeOptionalString(value)?.toLowerCase();
	return normalized ? normalized.replace(/_/g, "") : void 0;
}
function readRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function parseJsonRecord(value) {
	try {
		return readRecord(JSON.parse(value));
	} catch {
		return;
	}
}
function readMaybeJsonRecord(value) {
	if (typeof value === "string") return parseJsonRecord(value);
	return readRecord(value);
}
function readToolBlockName(block) {
	const direct = normalizeOptionalString(block.name) ?? normalizeOptionalString(block.toolName) ?? normalizeOptionalString(block.tool_name) ?? normalizeOptionalString(block.tool);
	if (direct) return direct;
	const fn = readRecord(block.function);
	return fn ? normalizeOptionalString(fn.name) : void 0;
}
function readToolBlockCallId(block) {
	return normalizeOptionalString(block.id) ?? normalizeOptionalString(block.toolCallId) ?? normalizeOptionalString(block.tool_call_id) ?? normalizeOptionalString(block.callId) ?? normalizeOptionalString(block.call_id);
}
function readToolBlockArguments(block) {
	for (const key of [
		"arguments",
		"input",
		"args",
		"params"
	]) {
		const args = readMaybeJsonRecord(block[key]);
		if (args) return args;
	}
	const fn = readRecord(block.function);
	if (fn) {
		const args = readMaybeJsonRecord(fn.arguments);
		if (args) return args;
	}
	return {};
}
function hasNonEmptyValue(value) {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.some(hasNonEmptyValue);
	if (!value || typeof value !== "object") return value != null;
	return Object.values(value).some(hasNonEmptyValue);
}
function hasExplicitMessageToolRoute(args) {
	return [
		"target",
		"targets",
		"to",
		"recipient",
		"recipients",
		"chatId",
		"chat_id",
		"channelId",
		"channel_id",
		"conversationId",
		"conversation_id",
		"threadId",
		"thread_id",
		"roomId",
		"room_id",
		"groupId",
		"group_id"
	].some((field) => hasNonEmptyValue(args[field]));
}
function readMessageToolVisibleText(args) {
	for (const field of [
		"message",
		"text",
		"content",
		"body",
		"caption"
	]) {
		const value = args[field];
		if (typeof value === "string" && value.trim()) return stripInlineDirectiveTagsForDisplay(value).text;
	}
}
function isDryRunMessageToolRecord(record) {
	if (record.dryRun === true || record.dry_run === true) return true;
	return (normalizeOptionalString(record.deliveryStatus) ?? normalizeOptionalString(record.delivery_status) ?? normalizeOptionalString(record.status))?.toLowerCase() === "dry_run";
}
function extractMessageToolVisibleReplies(message) {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const replies = [];
	for (const block of message.content) {
		const record = readRecord(block);
		if (!record) continue;
		const type = normalizeToolHistoryType(record.type);
		if (type !== "toolcall" && type !== "tooluse") continue;
		if (readToolBlockName(record)?.toLowerCase() !== "message") continue;
		const args = readToolBlockArguments(record);
		if (normalizeOptionalString(args.action)?.toLowerCase() !== "send") continue;
		if (isDryRunMessageToolRecord(args)) continue;
		if (hasExplicitMessageToolRoute(args)) continue;
		const text = readMessageToolVisibleText(args);
		if (!text?.trim()) continue;
		const toolCallId = readToolBlockCallId(record);
		replies.push({
			...toolCallId ? { toolCallId } : {},
			text
		});
	}
	return replies;
}
function isAssistantSilentControlReplyOnly(message) {
	const text = extractAssistantTextForSilentCheck(message);
	return text !== void 0 && isSuppressedControlReplyText(text) && !hasAssistantNonTextContent(message);
}
function isRenderableAssistantDisplayMessage(message) {
	if (message.role !== "assistant") return false;
	const text = extractAssistantTextForSilentCheck(message);
	return text !== void 0 && !isSuppressedControlReplyText(text);
}
function readMessageToolResultName(message) {
	return normalizeOptionalString(message.toolName) ?? normalizeOptionalString(message.tool_name) ?? normalizeOptionalString(message.name) ?? normalizeOptionalString(message.tool);
}
function readMessageToolResultCallId(message) {
	return normalizeOptionalString(message.toolCallId) ?? normalizeOptionalString(message.tool_call_id) ?? normalizeOptionalString(message.callId) ?? normalizeOptionalString(message.call_id) ?? normalizeOptionalString(message.id);
}
function readToolResultOkValue(value) {
	if (typeof value === "boolean") return value;
	const record = readMaybeJsonRecord(value);
	if (record && typeof record.ok === "boolean") return record.ok;
	if (Array.isArray(value)) for (const block of value) {
		const blockOk = readToolResultOkValue(block);
		if (blockOk !== void 0) return blockOk;
		const recordBlock = readRecord(block);
		if (typeof recordBlock?.text === "string") {
			const textOk = readToolResultOkValue(recordBlock.text);
			if (textOk !== void 0) return textOk;
		}
		if (typeof recordBlock?.content === "string") {
			const contentOk = readToolResultOkValue(recordBlock.content);
			if (contentOk !== void 0) return contentOk;
		}
	}
}
function hasDryRunToolResultValue(value) {
	const record = readMaybeJsonRecord(value);
	if (record && isDryRunMessageToolRecord(record)) return true;
	if (!Array.isArray(value)) return false;
	return value.some((block) => {
		if (hasDryRunToolResultValue(block)) return true;
		const recordBlock = readRecord(block);
		if (typeof recordBlock?.text === "string" && hasDryRunToolResultValue(recordBlock.text)) return true;
		return typeof recordBlock?.content === "string" && hasDryRunToolResultValue(recordBlock.content);
	});
}
function isSuccessfulMessageToolResult(message, pending) {
	const role = typeof message.role === "string" ? message.role.toLowerCase().replace(/_/g, "") : "";
	const toolName = readMessageToolResultName(message)?.toLowerCase();
	if (role !== "toolresult" && role !== "tool" && role !== "function" && toolName !== "message") return false;
	if (toolName && toolName !== "message") return false;
	const resultCallId = readMessageToolResultCallId(message);
	if (pending.toolCallId) return resultCallId === pending.toolCallId && isSuccessfulMessageToolResultPayload(message);
	return isSuccessfulMessageToolResultPayload(message);
}
function isSuccessfulMessageToolResultPayload(message) {
	if (message.isError === true || message.error != null && message.error !== false) return false;
	if (hasDryRunToolResultValue(message.result) || hasDryRunToolResultValue(message.output) || hasDryRunToolResultValue(message.content) || hasDryRunToolResultValue(message.text)) return false;
	return (readToolResultOkValue(message.result) ?? readToolResultOkValue(message.output) ?? readToolResultOkValue(message.content) ?? readToolResultOkValue(message.text)) !== false;
}
function buildMessageToolVisibleReplyMirror(pending) {
	const mirror = {
		role: "assistant",
		content: [{
			type: "text",
			text: pending.text
		}],
		openclawMessageToolMirror: {
			toolName: "message",
			...pending.toolCallId ? { toolCallId: pending.toolCallId } : {}
		}
	};
	for (const field of [
		"timestamp",
		"createdAt",
		"agentId"
	]) if (pending.anchor[field] !== void 0) mirror[field] = pending.anchor[field];
	const transcriptMeta = readRecord((pending.completionAnchor ?? pending.anchor)["__openclaw"]);
	if (transcriptMeta) mirror["__openclaw"] = { ...transcriptMeta };
	return mirror;
}
function mirrorMessageToolVisibleReplies(messages) {
	if (messages.length === 0) return messages;
	if (!messages.some((message) => readRecord(message))) return messages;
	let changed = false;
	const next = [];
	const pending = [];
	const clearPending = () => {
		if (pending.length > 0) pending.length = 0;
	};
	const flushSucceededMirrors = () => {
		for (const item of pending) {
			if (!item.succeeded) continue;
			next.push(buildMessageToolVisibleReplyMirror(item));
			changed = true;
		}
		clearPending();
	};
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const record = readRecord(message);
		if (!record) {
			next.push(message);
			continue;
		}
		if (record.role === "user") {
			clearPending();
			next.push(message);
			continue;
		}
		const visibleReplies = extractMessageToolVisibleReplies(record);
		if (visibleReplies.length > 0) for (const reply of visibleReplies) pending.push({
			...reply,
			anchor: record,
			succeeded: false
		});
		else if (isRenderableAssistantDisplayMessage(record)) clearPending();
		if (pending.length > 0) {
			for (const item of pending) if (!item.succeeded && isSuccessfulMessageToolResult(record, item)) {
				item.succeeded = true;
				item.completionAnchor = record;
			}
			if (isAssistantSilentControlReplyOnly(record)) flushSucceededMirrors();
		}
		next.push(message);
	}
	return changed ? next : messages;
}
function shouldDropAssistantHistoryMessage(message) {
	if (!message || typeof message !== "object") return false;
	if (message.role !== "assistant") return false;
	if (resolveAssistantMessagePhase(message) === "commentary") return !hasAssistantMixedToolVisibleText(message);
	const text = extractAssistantTextForSilentCheck(message);
	if (text === void 0 || !isSuppressedControlReplyText(text)) return false;
	return !hasAssistantNonTextContent(message);
}
function sanitizeChatHistoryMessages(messages, maxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS) {
	if (messages.length === 0) return messages;
	let changed = false;
	const next = [];
	for (const message of messages) {
		if (shouldDropAssistantHistoryMessage(message)) {
			changed = true;
			continue;
		}
		const res = sanitizeChatHistoryMessage(message, maxChars);
		changed ||= res.changed;
		if (shouldDropAssistantHistoryMessage(res.message)) {
			changed = true;
			continue;
		}
		next.push(res.message);
	}
	return changed ? next : messages;
}
function asRoleContentMessage(message) {
	const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
	if (!role) return null;
	return {
		role,
		...message.content !== void 0 ? { content: message.content } : message.text !== void 0 ? { content: message.text } : {}
	};
}
function isEmptyTextOnlyContent(content) {
	if (typeof content === "string") return content.trim().length === 0;
	if (!Array.isArray(content)) return false;
	if (content.length === 0) return true;
	let sawText = false;
	for (const block of content) {
		if (!block || typeof block !== "object") return false;
		const entry = block;
		if (entry.type !== "text") return false;
		sawText = true;
		if (typeof entry.text !== "string" || entry.text.trim().length > 0) return false;
	}
	return sawText;
}
function hasTranscriptMediaPaths(message) {
	return (Array.isArray(message.MediaPaths) ? message.MediaPaths : typeof message.MediaPath === "string" ? [message.MediaPath] : []).some((value) => typeof value === "string" && value.trim());
}
function extractProjectedText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const text = block.text;
		if (typeof text === "string") parts.push(text);
	}
	return parts.join("\n");
}
function digestTtsSupplementText(text) {
	return createHash("sha256").update(text.trim()).digest("hex");
}
function readTtsSupplementMarker(message) {
	const marker = message.openclawTtsSupplement;
	if (!marker || typeof marker !== "object" || Array.isArray(marker)) return;
	const entry = marker;
	const textSha256 = typeof entry.textSha256 === "string" && entry.textSha256.trim() ? entry.textSha256.trim() : void 0;
	const spokenText = typeof entry.spokenText === "string" && entry.spokenText.trim() ? entry.spokenText.trim() : void 0;
	return textSha256 || spokenText ? {
		textSha256,
		spokenText
	} : void 0;
}
function isAssistantTtsSupplementMessage(message) {
	if (asRoleContentMessage(message)?.role !== "assistant") return false;
	if (!readTtsSupplementMarker(message)) return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	let hasSupplementBlock = false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type !== "text") {
			hasSupplementBlock = true;
			continue;
		}
		const text = typeof block.text === "string" ? block.text.trim() : "";
		if (text && text !== "Audio reply") return false;
	}
	return hasSupplementBlock;
}
function ttsSupplementMatchesAssistant(marker, message) {
	if (asRoleContentMessage(message)?.role !== "assistant") return false;
	if (readTtsSupplementMarker(message)) return false;
	const text = extractProjectedText(message.content ?? message.text).trim();
	if (!text) return false;
	if (marker.textSha256 && digestTtsSupplementText(text) === marker.textSha256) return true;
	return Boolean(marker.spokenText && text === marker.spokenText);
}
function mergeTtsSupplementContent(target, supplement) {
	const supplementBlocks = Array.isArray(supplement.content) ? supplement.content.filter((block) => Boolean(block) && typeof block === "object" && block.type !== "text") : [];
	if (supplementBlocks.length === 0) return target;
	const targetContent = target.content;
	if (Array.isArray(targetContent)) return {
		...target,
		content: [...targetContent, ...supplementBlocks]
	};
	const targetText = extractProjectedText(targetContent ?? target.text).trim();
	return {
		...target,
		content: [...targetText ? [{
			type: "text",
			text: targetText
		}] : [], ...supplementBlocks]
	};
}
function mergeTtsSupplementMessages(messages) {
	if (!messages.some(isAssistantTtsSupplementMessage)) return messages;
	const merged = [];
	let changed = false;
	for (const message of messages) {
		const marker = readTtsSupplementMarker(message);
		if (marker && isAssistantTtsSupplementMessage(message)) {
			let targetIndex = -1;
			for (let i = merged.length - 1; i >= 0; i--) if (ttsSupplementMatchesAssistant(marker, merged[i])) {
				targetIndex = i;
				break;
			}
			if (targetIndex >= 0) {
				merged[targetIndex] = mergeTtsSupplementContent(merged[targetIndex], message);
				changed = true;
				continue;
			}
		}
		merged.push(message);
	}
	return changed ? merged : messages;
}
function isSubagentAnnounceInterSessionUserMessage(message) {
	const provenance = normalizeInputProvenance(message.provenance);
	if (provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") return true;
	const text = extractProjectedText(message.content ?? message.text);
	return text.includes("[Inter-session message]") && text.includes("sourceTool=subagent_announce");
}
function isDisplayHiddenProjectedMessage(message) {
	if (message.display === false) return true;
	return message.role === "custom" && message.customType === "openclaw.runtime-context";
}
function shouldHideProjectedHistoryMessage(message) {
	if (isDisplayHiddenProjectedMessage(message)) return true;
	const roleContent = asRoleContentMessage(message);
	if (!roleContent) return false;
	if (roleContent.role === "user" && isSubagentAnnounceInterSessionUserMessage(message)) return true;
	if (roleContent.role === "user" && isEmptyTextOnlyContent(message.content ?? message.text) && !hasTranscriptMediaPaths(message)) return true;
	if (roleContent.role === "assistant" && isEmptyTextOnlyContent(message.content ?? message.text)) return false;
	if (isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT)) return true;
	return isHeartbeatOkResponse(roleContent);
}
function toProjectedMessages(messages) {
	return messages.filter((message) => Boolean(message) && typeof message === "object" && !Array.isArray(message));
}
function filterVisibleProjectedHistoryMessages(messages) {
	if (messages.length === 0) return messages;
	let changed = false;
	const visible = [];
	for (let i = 0; i < messages.length; i++) {
		const current = messages[i];
		if (!current) continue;
		const currentRoleContent = asRoleContentMessage(current);
		const next = messages[i + 1];
		const nextRoleContent = next ? asRoleContentMessage(next) : null;
		if (currentRoleContent && nextRoleContent && isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT) && isHeartbeatOkResponse(nextRoleContent)) {
			changed = true;
			i++;
			continue;
		}
		if (shouldHideProjectedHistoryMessage(current)) {
			changed = true;
			continue;
		}
		visible.push(current);
	}
	return changed ? visible : messages;
}
function projectChatDisplayMessages(messages, options) {
	return sanitizeChatHistoryMessages(mergeTtsSupplementMessages(filterVisibleProjectedHistoryMessages(toProjectedMessages(sanitizeChatHistoryMessages(mirrorMessageToolVisibleReplies(options?.stripEnvelope === false ? messages : stripEnvelopeFromMessages(messages)), Number.MAX_SAFE_INTEGER)))), options?.maxChars ?? 8e3);
}
function limitChatDisplayMessages(messages, maxMessages) {
	if (typeof maxMessages !== "number" || !Number.isFinite(maxMessages) || maxMessages <= 0 || messages.length <= maxMessages) return messages;
	return messages.slice(-Math.floor(maxMessages));
}
function projectRecentChatDisplayMessages(messages, options) {
	return limitChatDisplayMessages(projectChatDisplayMessages(messages, options), options?.maxMessages);
}
function projectChatDisplayMessage(message, options) {
	return projectChatDisplayMessages([message], options)[0];
}
//#endregion
export { projectRecentChatDisplayMessages as a, projectChatDisplayMessages as i, isToolHistoryBlockType as n, resolveEffectiveChatHistoryMaxChars as o, projectChatDisplayMessage as r, DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS as t };
