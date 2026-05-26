import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue } from "./string-coerce-LndEvhRk.js";
import { a as SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS, c as isRedactedSessionsSpawnAttachment, i as REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT, l as normalizeAllowedToolNames, n as extractToolResultId, s as isAllowedToolCallName, t as extractToolCallsFromAssistant } from "./tool-call-id-DHd-I_KM.js";
//#region src/agents/session-transcript-repair.ts
const RAW_TOOL_CALL_BLOCK_TYPES = new Set([
	"toolCall",
	"toolUse",
	"functionCall",
	"tool_call",
	"tool_use",
	"function_call"
]);
function isThinkingLikeBlock(block) {
	if (!block || typeof block !== "object") return false;
	const type = block.type;
	return type === "thinking" || type === "redacted_thinking";
}
function isRawToolCallBlock(block) {
	if (!block || typeof block !== "object") return false;
	const type = block.type;
	return typeof type === "string" && RAW_TOOL_CALL_BLOCK_TYPES.has(type);
}
function hasToolCallInput(block) {
	const hasInput = "input" in block ? block.input !== void 0 && block.input !== null : false;
	const hasArguments = "arguments" in block ? block.arguments !== void 0 && block.arguments !== null : false;
	return hasInput || hasArguments;
}
function hasNonEmptyStringField(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function hasToolCallId(block) {
	return hasNonEmptyStringField(block.id) || hasNonEmptyStringField(block.call_id) || hasNonEmptyStringField(block.toolCallId) || hasNonEmptyStringField(block.toolUseId) || hasNonEmptyStringField(block.tool_call_id) || hasNonEmptyStringField(block.tool_use_id);
}
function redactSessionsSpawnAttachmentsArgs(value) {
	if (!value || typeof value !== "object") return value;
	const rec = value;
	const raw = rec.attachments;
	if (!Array.isArray(raw)) return value;
	let changed = false;
	const next = raw.map((item) => {
		if (isRedactedSessionsSpawnAttachment(item)) return item;
		changed = true;
		return redactSessionsSpawnAttachment(item);
	});
	if (!changed) return value;
	return {
		...rec,
		attachments: next
	};
}
function redactSessionsSpawnAcpArgs(value) {
	if (!value || typeof value !== "object") return value;
	const rec = value;
	const next = { ...rec };
	let changed = false;
	for (const key of ["resumeSessionId", "streamTo"]) if (Object.hasOwn(rec, key)) {
		next[key] = REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT;
		changed = true;
	}
	return changed ? next : value;
}
function redactSessionsSpawnArgs(value) {
	return redactSessionsSpawnAcpArgs(redactSessionsSpawnAttachmentsArgs(value));
}
function redactSessionsSpawnAttachment(item) {
	const next = { content: REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT };
	if (!item || typeof item !== "object") return next;
	const attachment = item;
	for (const key of SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS) {
		const value = attachment[key];
		if (typeof value === "string" && value.trim().length > 0) next[key] = value;
	}
	return next;
}
function sanitizeToolCallBlock(block) {
	const rawName = readStringValue(block.name);
	const trimmedName = rawName?.trim();
	const hasTrimmedName = typeof trimmedName === "string" && trimmedName.length > 0;
	const normalizedName = hasTrimmedName ? trimmedName : void 0;
	const nameChanged = hasTrimmedName && rawName !== trimmedName;
	if (!(normalizeLowercaseStringOrEmpty(normalizedName) === "sessions_spawn")) {
		if (!nameChanged) return block;
		return {
			...block,
			name: normalizedName
		};
	}
	const nextArgs = redactSessionsSpawnArgs(block.arguments);
	const nextInput = redactSessionsSpawnArgs(block.input);
	if (nextArgs === block.arguments && nextInput === block.input && !nameChanged) return block;
	const next = { ...block };
	if (nameChanged && normalizedName) next.name = normalizedName;
	if (nextArgs !== block.arguments || Object.hasOwn(block, "arguments")) next.arguments = nextArgs;
	if (nextInput !== block.input || Object.hasOwn(block, "input")) next.input = nextInput;
	return next;
}
function countRawToolCallBlocks(content) {
	let count = 0;
	for (const block of content) if (isRawToolCallBlock(block)) count += 1;
	return count;
}
function isReplaySafeThinkingAssistantTurn(content, allowedToolNames) {
	let sawToolCall = false;
	const seenToolCallIds = /* @__PURE__ */ new Set();
	for (const block of content) {
		if (!isRawToolCallBlock(block)) continue;
		sawToolCall = true;
		const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
		if (!hasToolCallInput(block) || !toolCallId || seenToolCallIds.has(toolCallId) || !isAllowedToolCallName(block.name, allowedToolNames)) return false;
		seenToolCallIds.add(toolCallId);
		if (sanitizeToolCallBlock(block) !== block) return false;
	}
	return sawToolCall;
}
function makeMissingToolResult(params) {
	return {
		role: "toolResult",
		toolCallId: params.toolCallId,
		toolName: params.toolName ?? "unknown",
		content: [{
			type: "text",
			text: params.text ?? "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair."
		}],
		isError: true,
		timestamp: Date.now()
	};
}
function normalizeToolResultName(message, fallbackName) {
	const rawToolName = message.toolName;
	const normalizedToolName = normalizeOptionalString(rawToolName);
	if (normalizedToolName) {
		if (rawToolName === normalizedToolName) return message;
		return {
			...message,
			toolName: normalizedToolName
		};
	}
	const normalizedFallback = normalizeOptionalString(fallbackName);
	if (normalizedFallback) return {
		...message,
		toolName: normalizedFallback
	};
	if (typeof rawToolName === "string") return {
		...message,
		toolName: "unknown"
	};
	return message;
}
function stripToolResultDetails(messages) {
	let touched = false;
	const out = [];
	for (const msg of messages) {
		if (!msg || typeof msg !== "object" || msg.role !== "toolResult") {
			out.push(msg);
			continue;
		}
		if (!("details" in msg)) {
			out.push(msg);
			continue;
		}
		const sanitized = { ...msg };
		delete sanitized.details;
		touched = true;
		out.push(sanitized);
	}
	return touched ? out : messages;
}
function repairToolCallInputs(messages, options) {
	let droppedToolCalls = 0;
	let droppedAssistantMessages = 0;
	let changed = false;
	const out = [];
	const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
	const allowProviderOwnedThinkingReplay = options?.allowProviderOwnedThinkingReplay === true;
	const claimedReplaySafeToolCallIds = /* @__PURE__ */ new Set();
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") {
			out.push(msg);
			continue;
		}
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
			out.push(msg);
			continue;
		}
		if (allowProviderOwnedThinkingReplay && msg.content.some((block) => isThinkingLikeBlock(block)) && countRawToolCallBlocks(msg.content) > 0) {
			const replaySafeToolCalls = extractToolCallsFromAssistant(msg);
			if (isReplaySafeThinkingAssistantTurn(msg.content, allowedToolNames) && replaySafeToolCalls.every((toolCall) => !claimedReplaySafeToolCallIds.has(toolCall.id))) {
				for (const toolCall of replaySafeToolCalls) claimedReplaySafeToolCallIds.add(toolCall.id);
				out.push(msg);
			} else {
				droppedToolCalls += countRawToolCallBlocks(msg.content);
				droppedAssistantMessages += 1;
				changed = true;
			}
			continue;
		}
		const nextContent = [];
		let droppedInMessage = 0;
		let messageChanged = false;
		for (const block of msg.content) {
			if (isRawToolCallBlock(block) && (!hasToolCallInput(block) || !hasToolCallId(block) || !isAllowedToolCallName(block.name, allowedToolNames))) {
				droppedToolCalls += 1;
				droppedInMessage += 1;
				changed = true;
				messageChanged = true;
				continue;
			}
			if (isRawToolCallBlock(block)) {
				if (RAW_TOOL_CALL_BLOCK_TYPES.has(block.type ?? "")) {
					if (normalizeLowercaseStringOrEmpty(typeof block.name === "string" ? block.name.trim() : void 0) === "sessions_spawn") {
						const sanitized = sanitizeToolCallBlock(block);
						if (sanitized !== block) {
							changed = true;
							messageChanged = true;
						}
						nextContent.push(sanitized);
					} else if (typeof block.name === "string") {
						const rawName = block.name;
						const trimmedName = rawName.trim();
						if (rawName !== trimmedName && trimmedName) {
							const renamed = {
								...block,
								name: trimmedName
							};
							nextContent.push(renamed);
							changed = true;
							messageChanged = true;
						} else nextContent.push(block);
					} else nextContent.push(block);
					continue;
				}
			} else nextContent.push(block);
		}
		if (droppedInMessage > 0) {
			if (nextContent.length === 0) {
				droppedAssistantMessages += 1;
				changed = true;
				continue;
			}
			out.push({
				...msg,
				content: nextContent
			});
			continue;
		}
		if (messageChanged) {
			out.push({
				...msg,
				content: nextContent
			});
			continue;
		}
		out.push(msg);
	}
	return {
		messages: changed ? out : messages,
		droppedToolCalls,
		droppedAssistantMessages
	};
}
function sanitizeToolCallInputs(messages, options) {
	return repairToolCallInputs(messages, options).messages;
}
function sanitizeToolUseResultPairing(messages, options) {
	return repairToolUseResultPairing(messages, options).messages;
}
function shouldDropErroredAssistantResults(options) {
	return options?.erroredAssistantResultPolicy === "drop";
}
function assistantHasToolCalls(message) {
	if (!message || typeof message !== "object" || message.role !== "assistant") return false;
	return extractToolCallsFromAssistant(message).length > 0;
}
function repairToolUseResultPairing(messages, options) {
	const out = [];
	const added = [];
	const seenToolResultIds = /* @__PURE__ */ new Set();
	let droppedDuplicateCount = 0;
	let droppedOrphanCount = 0;
	let moved = false;
	let changed = false;
	const pushToolResult = (msg) => {
		const id = extractToolResultId(msg);
		if (id && seenToolResultIds.has(id)) {
			droppedDuplicateCount += 1;
			changed = true;
			return;
		}
		if (id) seenToolResultIds.add(id);
		out.push(msg);
	};
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") {
			out.push(msg);
			continue;
		}
		const role = msg.role;
		if (role !== "assistant") {
			if (role !== "toolResult") out.push(msg);
			else {
				droppedOrphanCount += 1;
				changed = true;
			}
			continue;
		}
		const assistant = msg;
		const toolCalls = extractToolCallsFromAssistant(assistant);
		if (toolCalls.length === 0) {
			out.push(msg);
			continue;
		}
		const toolCallIds = /* @__PURE__ */ new Set();
		const toolCallNamesById = /* @__PURE__ */ new Map();
		for (const toolCall of toolCalls) {
			toolCallIds.add(toolCall.id);
			if (typeof toolCall.name === "string") toolCallNamesById.set(toolCall.id, toolCall.name);
		}
		const spanResultsById = /* @__PURE__ */ new Map();
		const remainder = [];
		let j = i + 1;
		for (; j < messages.length; j += 1) {
			const next = messages[j];
			if (!next || typeof next !== "object") {
				remainder.push(next);
				continue;
			}
			const nextRole = next.role;
			if (nextRole === "assistant") {
				if (assistantHasToolCalls(next)) break;
				remainder.push(next);
				continue;
			}
			if (nextRole === "toolResult") {
				const toolResult = next;
				const id = extractToolResultId(toolResult);
				if (id && toolCallIds.has(id)) {
					if (seenToolResultIds.has(id)) {
						droppedDuplicateCount += 1;
						changed = true;
						continue;
					}
					const normalizedToolResult = normalizeToolResultName(toolResult, toolCallNamesById.get(id));
					if (normalizedToolResult !== toolResult) changed = true;
					if (!spanResultsById.has(id)) spanResultsById.set(id, normalizedToolResult);
					continue;
				}
			}
			if (nextRole !== "toolResult") remainder.push(next);
			else {
				droppedOrphanCount += 1;
				changed = true;
			}
		}
		const stopReason = assistant.stopReason;
		if (stopReason === "error" || stopReason === "aborted") {
			if (!shouldDropErroredAssistantResults(options)) {
				out.push(msg);
				for (const toolCall of toolCalls) {
					const result = spanResultsById.get(toolCall.id);
					if (!result) continue;
					pushToolResult(result);
				}
			} else if (spanResultsById.size > 0) changed = true;
			else changed = true;
			for (const rem of remainder) out.push(rem);
			i = j - 1;
			continue;
		}
		out.push(msg);
		if (spanResultsById.size > 0 && remainder.length > 0) {
			moved = true;
			changed = true;
		}
		for (const call of toolCalls) {
			const existing = spanResultsById.get(call.id);
			if (existing) pushToolResult(existing);
			else {
				const missing = makeMissingToolResult({
					toolCallId: call.id,
					toolName: call.name,
					text: options?.missingToolResultText
				});
				added.push(missing);
				changed = true;
				pushToolResult(missing);
			}
		}
		for (const rem of remainder) {
			if (!rem || typeof rem !== "object") {
				out.push(rem);
				continue;
			}
			out.push(rem);
		}
		i = j - 1;
	}
	const changedOrMoved = changed || moved;
	return {
		messages: changedOrMoved ? out : messages,
		added,
		droppedDuplicateCount,
		droppedOrphanCount,
		moved: changedOrMoved
	};
}
//#endregion
export { stripToolResultDetails as a, sanitizeToolUseResultPairing as i, repairToolUseResultPairing as n, sanitizeToolCallInputs as r, makeMissingToolResult as t };
