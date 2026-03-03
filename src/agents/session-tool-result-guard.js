import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { HARD_MAX_TOOL_RESULT_CHARS, truncateToolResultMessage, } from "./pi-embedded-runner/tool-result-truncation.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";
const GUARD_TRUNCATION_SUFFIX = "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
    "Use offset/limit parameters or request specific sections for large content.]";
/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg) {
    if (msg.role !== "toolResult") {
        return msg;
    }
    return truncateToolResultMessage(msg, HARD_MAX_TOOL_RESULT_CHARS, {
        suffix: GUARD_TRUNCATION_SUFFIX,
        minKeepChars: 2000,
    });
}
function trimNonEmptyString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
function normalizePersistedToolResultName(message, fallbackName) {
    if (message.role !== "toolResult") {
        return message;
    }
    const toolResult = message;
    const rawToolName = toolResult.toolName;
    const normalizedToolName = trimNonEmptyString(rawToolName);
    if (normalizedToolName) {
        if (rawToolName === normalizedToolName) {
            return toolResult;
        }
        return { ...toolResult, toolName: normalizedToolName };
    }
    const normalizedFallback = trimNonEmptyString(fallbackName);
    if (normalizedFallback) {
        return { ...toolResult, toolName: normalizedFallback };
    }
    if (typeof rawToolName === "string") {
        return { ...toolResult, toolName: "unknown" };
    }
    return toolResult;
}
export function installSessionToolResultGuard(sessionManager, opts) {
    const originalAppend = sessionManager.appendMessage.bind(sessionManager);
    const pending = new Map();
    const persistMessage = (message) => {
        const transformer = opts?.transformMessageForPersistence;
        return transformer ? transformer(message) : message;
    };
    const persistToolResult = (message, meta) => {
        const transformer = opts?.transformToolResultForPersistence;
        return transformer ? transformer(message, meta) : message;
    };
    const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
    const beforeWrite = opts?.beforeMessageWriteHook;
    /**
     * Run the before_message_write hook. Returns the (possibly modified) message,
     * or null if the message should be blocked.
     */
    const applyBeforeWriteHook = (msg) => {
        if (!beforeWrite) {
            return msg;
        }
        const result = beforeWrite({ message: msg });
        if (result?.block) {
            return null;
        }
        if (result?.message) {
            return result.message;
        }
        return msg;
    };
    const flushPendingToolResults = () => {
        if (pending.size === 0) {
            return;
        }
        if (allowSyntheticToolResults) {
            for (const [id, name] of pending.entries()) {
                const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
                const flushed = applyBeforeWriteHook(persistToolResult(persistMessage(synthetic), {
                    toolCallId: id,
                    toolName: name,
                    isSynthetic: true,
                }));
                if (flushed) {
                    originalAppend(flushed);
                }
            }
        }
        pending.clear();
    };
    const guardedAppend = (message) => {
        let nextMessage = message;
        const role = message.role;
        if (role === "assistant") {
            const sanitized = sanitizeToolCallInputs([message], {
                allowedToolNames: opts?.allowedToolNames,
            });
            if (sanitized.length === 0) {
                if (allowSyntheticToolResults && pending.size > 0) {
                    flushPendingToolResults();
                }
                return undefined;
            }
            nextMessage = sanitized[0];
        }
        const nextRole = nextMessage.role;
        if (nextRole === "toolResult") {
            const id = extractToolResultId(nextMessage);
            const toolName = id ? pending.get(id) : undefined;
            if (id) {
                pending.delete(id);
            }
            const normalizedToolResult = normalizePersistedToolResultName(nextMessage, toolName);
            // Apply hard size cap before persistence to prevent oversized tool results
            // from consuming the entire context window on subsequent LLM calls.
            const capped = capToolResultSize(persistMessage(normalizedToolResult));
            const persisted = applyBeforeWriteHook(persistToolResult(capped, {
                toolCallId: id ?? undefined,
                toolName,
                isSynthetic: false,
            }));
            if (!persisted) {
                return undefined;
            }
            return originalAppend(persisted);
        }
        // Skip tool call extraction for aborted/errored assistant messages.
        // When stopReason is "error" or "aborted", the tool_use blocks may be incomplete
        // and should not have synthetic tool_results created. Creating synthetic results
        // for incomplete tool calls causes API 400 errors:
        // "unexpected tool_use_id found in tool_result blocks"
        // This matches the behavior in repairToolUseResultPairing (session-transcript-repair.ts)
        const stopReason = nextMessage.stopReason;
        const toolCalls = nextRole === "assistant" && stopReason !== "aborted" && stopReason !== "error"
            ? extractToolCallsFromAssistant(nextMessage)
            : [];
        if (allowSyntheticToolResults) {
            // If previous tool calls are still pending, flush before non-tool results.
            if (pending.size > 0 && (toolCalls.length === 0 || nextRole !== "assistant")) {
                flushPendingToolResults();
            }
            // If new tool calls arrive while older ones are pending, flush the old ones first.
            if (pending.size > 0 && toolCalls.length > 0) {
                flushPendingToolResults();
            }
        }
        const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
        if (!finalMessage) {
            return undefined;
        }
        const result = originalAppend(finalMessage);
        const sessionFile = sessionManager.getSessionFile?.();
        if (sessionFile) {
            emitSessionTranscriptUpdate(sessionFile);
        }
        if (toolCalls.length > 0) {
            for (const call of toolCalls) {
                pending.set(call.id, call.name);
            }
        }
        return result;
    };
    // Monkey-patch appendMessage with our guarded version.
    sessionManager.appendMessage = guardedAppend;
    return {
        flushPendingToolResults,
        getPendingIds: () => Array.from(pending.keys()),
    };
}
