import { s as normalizeInputProvenance } from "./input-provenance-cioGkz6Z.js";
import { a as parseAssistantTextSignature, s as resolveAssistantMessagePhase } from "./chat-message-content-Df8A1xtk.js";
import { n as HEARTBEAT_PROMPT } from "./heartbeat-DJ4ZZ8Yg.js";
import { n as isHeartbeatOkResponse, r as isHeartbeatUserMessage } from "./heartbeat-filter-BggY5OOJ.js";
import { i as stripInlineDirectiveTagsForDisplay } from "./directive-tags-BJVNV8sk.js";
import { g as stripEnvelopeFromMessages } from "./session-utils.fs-DNQef1OS.js";
import { n as isSuppressedControlReplyText } from "./control-reply-text-CmzSiDP9.js";
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
		"totalTokens",
		"inputTokens",
		"outputTokens",
		"cacheRead",
		"cacheWrite",
		"cache_read_input_tokens",
		"cache_creation_input_tokens"
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
function isSubagentAnnounceInterSessionUserMessage(message) {
	const provenance = normalizeInputProvenance(message.provenance);
	if (provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") return true;
	const text = extractProjectedText(message.content ?? message.text);
	return text.includes("[Inter-session message]") && text.includes("sourceTool=subagent_announce");
}
function shouldHideProjectedHistoryMessage(message) {
	const roleContent = asRoleContentMessage(message);
	if (!roleContent) return false;
	if (roleContent.role === "user" && isSubagentAnnounceInterSessionUserMessage(message)) return true;
	if (roleContent.role === "user" && isEmptyTextOnlyContent(message.content ?? message.text)) return true;
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
	return filterVisibleProjectedHistoryMessages(toProjectedMessages(sanitizeChatHistoryMessages(options?.stripEnvelope === false ? messages : stripEnvelopeFromMessages(messages), options?.maxChars ?? 8e3)));
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
