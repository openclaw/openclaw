import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";
function isToolCallBlock(block) {
    return block.type === "toolUse" || block.type === "toolCall" || block.type === "functionCall";
}
function isThinkingLikeBlock(block) {
    if (!block || typeof block !== "object") {
        return false;
    }
    const type = block.type;
    return type === "thinking" || type === "redacted_thinking";
}
function isAbortedAssistantTurn(message) {
    const stopReason = message.stopReason;
    return stopReason === "aborted" || stopReason === "error";
}
function extractToolResultMatchIds(record) {
    const ids = new Set();
    for (const value of [
        record.toolUseId,
        record.toolCallId,
        record.tool_use_id,
        record.tool_call_id,
        record.callId,
        record.call_id,
    ]) {
        const id = normalizeOptionalString(value);
        if (id) {
            ids.add(id);
        }
    }
    return ids;
}
function extractToolResultMatchName(record) {
    return normalizeOptionalString(record.toolName) ?? normalizeOptionalString(record.name) ?? null;
}
function collectAnyToolResultIds(message) {
    const ids = new Set();
    const role = message.role;
    if (role === "toolResult") {
        const toolResultId = extractToolResultId(message);
        if (toolResultId) {
            ids.add(toolResultId);
        }
    }
    else if (role === "tool") {
        const record = message;
        for (const id of extractToolResultMatchIds(record)) {
            ids.add(id);
        }
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return ids;
    }
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const record = block;
        if (record.type !== "toolResult" && record.type !== "tool") {
            continue;
        }
        for (const id of extractToolResultMatchIds(record)) {
            ids.add(id);
        }
    }
    return ids;
}
function collectTrustedToolResultMatches(message) {
    const matches = new Map();
    const role = message.role;
    const addMatch = (ids, toolName) => {
        for (const id of ids) {
            const bucket = matches.get(id) ?? new Set();
            if (toolName) {
                bucket.add(toolName);
            }
            matches.set(id, bucket);
        }
    };
    if (role === "toolResult") {
        const record = message;
        addMatch([
            ...extractToolResultMatchIds(record),
            ...(() => {
                const canonicalId = extractToolResultId(message);
                return canonicalId ? [canonicalId] : [];
            })(),
        ], extractToolResultMatchName(record));
    }
    else if (role === "tool") {
        const record = message;
        addMatch(extractToolResultMatchIds(record), extractToolResultMatchName(record));
    }
    return matches;
}
function collectFutureToolResultMatches(messages, startIndex) {
    const matches = new Map();
    for (let index = startIndex + 1; index < messages.length; index += 1) {
        const candidate = messages[index];
        if (!candidate || typeof candidate !== "object") {
            continue;
        }
        if (candidate.role === "assistant") {
            break;
        }
        for (const [id, toolNames] of collectTrustedToolResultMatches(candidate)) {
            const bucket = matches.get(id) ?? new Set();
            for (const toolName of toolNames) {
                bucket.add(toolName);
            }
            matches.set(id, bucket);
        }
    }
    return matches;
}
function collectFutureToolResultIds(messages, startIndex) {
    const ids = new Set();
    for (let index = startIndex + 1; index < messages.length; index += 1) {
        const candidate = messages[index];
        if (!candidate || typeof candidate !== "object") {
            continue;
        }
        if (candidate.role === "assistant") {
            break;
        }
        for (const id of collectAnyToolResultIds(candidate)) {
            ids.add(id);
        }
    }
    return ids;
}
/**
 * Strips dangling tool-call blocks from assistant messages when no later
 * tool-result span before the next assistant turn resolves them.
 * This fixes the "tool_use ids found without tool_result blocks" error from Anthropic.
 */
function stripDanglingAnthropicToolUses(messages) {
    const result = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== "object") {
            result.push(msg);
            continue;
        }
        const msgRole = msg.role;
        if (msgRole !== "assistant") {
            result.push(msg);
            continue;
        }
        const assistantMsg = msg;
        const originalContent = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
        if (originalContent.length === 0) {
            result.push(msg);
            continue;
        }
        if (extractToolCallsFromAssistant(msg).length ===
            0) {
            result.push(msg);
            continue;
        }
        const hasThinking = originalContent.some((block) => isThinkingLikeBlock(block));
        const validToolResultMatches = collectFutureToolResultMatches(messages, i);
        const validToolUseIds = collectFutureToolResultIds(messages, i);
        if (hasThinking) {
            const allToolCallsResolvable = originalContent.every((block) => {
                if (!block || !isToolCallBlock(block)) {
                    return true;
                }
                const blockId = normalizeOptionalString(block.id);
                const blockName = normalizeOptionalString(block.name);
                if (!blockId || !blockName) {
                    return false;
                }
                const matchingToolNames = validToolResultMatches.get(blockId);
                if (!matchingToolNames) {
                    return false;
                }
                return matchingToolNames.size === 0 || matchingToolNames.has(blockName);
            });
            if (allToolCallsResolvable) {
                result.push(msg);
            }
            else {
                result.push({
                    ...assistantMsg,
                    content: isAbortedAssistantTurn(msg)
                        ? []
                        : [{ type: "text", text: "[tool calls omitted]" }],
                });
            }
            continue;
        }
        const filteredContent = originalContent.filter((block) => {
            if (!block) {
                return false;
            }
            if (!isToolCallBlock(block)) {
                return true;
            }
            const blockId = normalizeOptionalString(block.id);
            return blockId ? validToolUseIds.has(blockId) : false;
        });
        if (filteredContent.length === originalContent.length) {
            result.push(msg);
            continue;
        }
        if (originalContent.length > 0 && filteredContent.length === 0) {
            result.push({
                ...assistantMsg,
                content: isAbortedAssistantTurn(msg)
                    ? []
                    : [{ type: "text", text: "[tool calls omitted]" }],
            });
        }
        else {
            result.push({
                ...assistantMsg,
                content: filteredContent,
            });
        }
    }
    return result;
}
function validateTurnsWithConsecutiveMerge(params) {
    const { messages, role, merge } = params;
    if (!Array.isArray(messages) || messages.length === 0) {
        return messages;
    }
    const result = [];
    let lastRole;
    for (const msg of messages) {
        if (!msg || typeof msg !== "object") {
            result.push(msg);
            continue;
        }
        const msgRole = msg.role;
        if (!msgRole) {
            result.push(msg);
            continue;
        }
        if (msgRole === lastRole && lastRole === role) {
            const lastMsg = result[result.length - 1];
            const currentMsg = msg;
            if (lastMsg && typeof lastMsg === "object") {
                const lastTyped = lastMsg;
                result[result.length - 1] = merge(lastTyped, currentMsg);
                continue;
            }
        }
        result.push(msg);
        lastRole = msgRole;
    }
    return result;
}
function mergeConsecutiveAssistantTurns(previous, current) {
    const mergedContent = [
        ...(Array.isArray(previous.content) ? previous.content : []),
        ...(Array.isArray(current.content) ? current.content : []),
    ];
    return {
        ...previous,
        content: mergedContent,
        ...(current.usage && { usage: current.usage }),
        ...(current.stopReason && { stopReason: current.stopReason }),
        ...(current.errorMessage && {
            errorMessage: current.errorMessage,
        }),
    };
}
/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * Merges consecutive assistant messages together.
 */
export function validateGeminiTurns(messages) {
    return validateTurnsWithConsecutiveMerge({
        messages,
        role: "assistant",
        merge: mergeConsecutiveAssistantTurns,
    });
}
export function mergeConsecutiveUserTurns(previous, current) {
    const mergedContent = [
        ...(Array.isArray(previous.content) ? previous.content : []),
        ...(Array.isArray(current.content) ? current.content : []),
    ];
    return {
        ...current,
        content: mergedContent,
        timestamp: current.timestamp ?? previous.timestamp,
    };
}
/**
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern.
 * Merges consecutive user messages together.
 * Also strips dangling tool_use blocks that lack corresponding tool_result blocks.
 */
export function validateAnthropicTurns(messages) {
    // First, strip dangling tool-call blocks from assistant messages.
    const stripped = stripDanglingAnthropicToolUses(messages);
    return validateTurnsWithConsecutiveMerge({
        messages: stripped,
        role: "user",
        merge: mergeConsecutiveUserTurns,
    });
}
