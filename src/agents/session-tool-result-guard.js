import { boundedJsonUtf8Bytes, firstEnumerableOwnKeys, jsonUtf8BytesOrInfinity, } from "../infra/json-utf8-bytes.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatContextLimitTruncationNotice } from "./pi-embedded-runner/tool-result-context-guard.js";
import { DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS, truncateToolResultMessage, } from "./pi-embedded-runner/tool-result-truncation.js";
import { getRawSessionAppendMessage, setRawSessionAppendMessage, } from "./session-raw-append-message.js";
import { createPendingToolCallState } from "./session-tool-result-state.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";
/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg, maxChars) {
    if (msg.role !== "toolResult") {
        return msg;
    }
    return truncateToolResultMessage(msg, maxChars, {
        suffix: (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars),
        minKeepChars: 2_000,
    });
}
function resolveMaxToolResultChars(opts) {
    return Math.max(1, opts?.maxToolResultChars ?? DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
}
// `details` is runtime/UI metadata, not model-visible tool output. Keep the
// session JSONL useful for debugging without letting metadata blobs dominate
// disk, replay repair, transcript broadcasts, or future tooling that reads raw
// sessions. Model-visible text belongs in tool result `content`.
const MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES = 8_192;
const MAX_PERSISTED_DETAIL_STRING_CHARS = 2_000;
const MAX_PERSISTED_DETAIL_SESSION_COUNT = 10;
const MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS = 200;
function originalDetailsSizeFields(size) {
    return size.complete
        ? { originalDetailsBytes: size.bytes }
        : { originalDetailsBytesAtLeast: size.bytes };
}
function truncatePersistedDetailString(value, maxChars = MAX_PERSISTED_DETAIL_STRING_CHARS) {
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars)}\n\n[OpenClaw persisted detail truncated: ${value.length - maxChars} chars omitted]`;
}
function sanitizePersistedSessionDetail(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    const src = value;
    const out = {};
    for (const key of [
        "sessionId",
        "status",
        "pid",
        "startedAt",
        "endedAt",
        "runtimeMs",
        "cwd",
        "name",
        "truncated",
        "exitCode",
        "exitSignal",
    ]) {
        const field = src[key];
        if (field !== undefined) {
            out[key] = typeof field === "string" ? truncatePersistedDetailString(field, 500) : field;
        }
    }
    if (typeof src.command === "string") {
        out.command = truncatePersistedDetailString(src.command, 500);
    }
    return out;
}
function buildPersistedDetailsFallback(src, originalSize, sanitizedBytes) {
    // If even the structured summary is too large, keep only shape and stable
    // status fields. This preserves "what happened?" without persisting the raw
    // diagnostics payload that caused the cap to trip.
    const fallback = {
        persistedDetailsTruncated: true,
        finalDetailsTruncated: true,
        ...originalDetailsSizeFields(originalSize),
    };
    if (sanitizedBytes !== undefined) {
        fallback.sanitizedDetailsBytes = sanitizedBytes;
    }
    if (src) {
        fallback.originalDetailKeys = firstEnumerableOwnKeys(src, 40);
        for (const key of ["status", "sessionId", "pid", "exitCode", "exitSignal", "truncated"]) {
            const field = src[key];
            if (field !== undefined) {
                fallback[key] =
                    typeof field === "string"
                        ? truncatePersistedDetailString(field, MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS)
                        : field;
            }
        }
    }
    return fallback;
}
function enforcePersistedDetailsByteCap(value, src, originalSize) {
    const sanitizedBytes = jsonUtf8BytesOrInfinity(value);
    if (sanitizedBytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
        return value;
    }
    const fallback = buildPersistedDetailsFallback(src, originalSize, sanitizedBytes);
    if (jsonUtf8BytesOrInfinity(fallback) <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
        return fallback;
    }
    return {
        persistedDetailsTruncated: true,
        finalDetailsTruncated: true,
        ...originalDetailsSizeFields(originalSize),
        sanitizedDetailsBytes: sanitizedBytes,
    };
}
function sanitizeToolResultDetailsForPersistence(details) {
    if (details === undefined || details === null) {
        return details;
    }
    // Measure with an early-exit walker so hostile or enormous details do not
    // need to be fully stringified just to learn they exceed the persistence cap.
    const originalSize = boundedJsonUtf8Bytes(details, MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES);
    if (originalSize.complete && originalSize.bytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
        return details;
    }
    if (typeof details !== "object") {
        return enforcePersistedDetailsByteCap({
            persistedDetailsTruncated: true,
            ...originalDetailsSizeFields(originalSize),
            valueType: typeof details,
        }, undefined, originalSize);
    }
    const src = details;
    const out = {
        persistedDetailsTruncated: true,
        ...originalDetailsSizeFields(originalSize),
        originalDetailKeys: firstEnumerableOwnKeys(src, 40),
    };
    for (const key of [
        "status",
        "sessionId",
        "pid",
        "startedAt",
        "endedAt",
        "cwd",
        "name",
        "exitCode",
        "exitSignal",
        "retryInMs",
        "total",
        "totalLines",
        "totalChars",
        "truncated",
        "fullOutputPath",
        "truncation",
    ]) {
        const field = src[key];
        if (field !== undefined) {
            out[key] = typeof field === "string" ? truncatePersistedDetailString(field) : field;
        }
    }
    if (typeof src.tail === "string") {
        out.tail = truncatePersistedDetailString(src.tail);
    }
    if (Array.isArray(src.sessions)) {
        out.sessions = src.sessions
            .slice(0, MAX_PERSISTED_DETAIL_SESSION_COUNT)
            .map(sanitizePersistedSessionDetail);
        if (src.sessions.length > MAX_PERSISTED_DETAIL_SESSION_COUNT) {
            out.sessionsTruncated = src.sessions.length - MAX_PERSISTED_DETAIL_SESSION_COUNT;
        }
    }
    return enforcePersistedDetailsByteCap(out, src, originalSize);
}
function capToolResultDetails(msg) {
    if (msg.role !== "toolResult") {
        return msg;
    }
    const details = msg.details;
    const sanitizedDetails = sanitizeToolResultDetailsForPersistence(details);
    if (sanitizedDetails === details) {
        return msg;
    }
    const next = { ...msg };
    next.details = sanitizedDetails;
    return next;
}
function capToolResultForPersistence(msg, maxChars) {
    return capToolResultDetails(capToolResultSize(msg, maxChars));
}
function normalizePersistedToolResultName(message, fallbackName) {
    if (message.role !== "toolResult") {
        return message;
    }
    const toolResult = message;
    const rawToolName = toolResult.toolName;
    const normalizedToolName = normalizeOptionalString(rawToolName);
    if (normalizedToolName) {
        if (rawToolName === normalizedToolName) {
            return toolResult;
        }
        return { ...toolResult, toolName: normalizedToolName };
    }
    const normalizedFallback = normalizeOptionalString(fallbackName);
    if (normalizedFallback) {
        return { ...toolResult, toolName: normalizedFallback };
    }
    if (typeof rawToolName === "string") {
        return { ...toolResult, toolName: "unknown" };
    }
    return toolResult;
}
export { getRawSessionAppendMessage };
export function installSessionToolResultGuard(sessionManager, opts) {
    const originalAppend = getRawSessionAppendMessage(sessionManager);
    setRawSessionAppendMessage(sessionManager, originalAppend);
    const pendingState = createPendingToolCallState();
    const persistMessage = (message) => {
        const transformer = opts?.transformMessageForPersistence;
        return transformer ? transformer(message) : message;
    };
    const persistToolResult = (message, meta) => {
        const transformer = opts?.transformToolResultForPersistence;
        return transformer ? transformer(message, meta) : message;
    };
    const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
    const missingToolResultText = opts?.missingToolResultText;
    const beforeWrite = opts?.beforeMessageWriteHook;
    const maxToolResultChars = resolveMaxToolResultChars(opts);
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
        if (pendingState.size() === 0) {
            return;
        }
        if (allowSyntheticToolResults) {
            for (const [id, name] of pendingState.entries()) {
                const synthetic = makeMissingToolResult({
                    toolCallId: id,
                    toolName: name,
                    text: missingToolResultText,
                });
                const flushed = applyBeforeWriteHook(persistToolResult(persistMessage(synthetic), {
                    toolCallId: id,
                    toolName: name,
                    isSynthetic: true,
                }));
                if (flushed) {
                    originalAppend(capToolResultForPersistence(flushed, maxToolResultChars));
                }
            }
        }
        pendingState.clear();
    };
    const clearPendingToolResults = () => {
        pendingState.clear();
    };
    const guardedAppend = (message) => {
        let nextMessage = message;
        const role = message.role;
        if (role === "assistant") {
            const sanitized = sanitizeToolCallInputs([message], {
                allowedToolNames: opts?.allowedToolNames,
            });
            if (sanitized.length === 0) {
                if (pendingState.shouldFlushForSanitizedDrop()) {
                    flushPendingToolResults();
                }
                return undefined;
            }
            nextMessage = sanitized[0];
        }
        const nextRole = nextMessage.role;
        if (nextRole === "toolResult") {
            const id = extractToolResultId(nextMessage);
            const toolName = id ? pendingState.getToolName(id) : undefined;
            if (id) {
                pendingState.delete(id);
            }
            const normalizedToolResult = normalizePersistedToolResultName(nextMessage, toolName);
            // Apply hard size cap before persistence to prevent oversized tool results
            // from consuming the entire context window on subsequent LLM calls.
            const capped = capToolResultForPersistence(persistMessage(normalizedToolResult), maxToolResultChars);
            const persisted = applyBeforeWriteHook(persistToolResult(capped, {
                toolCallId: id ?? undefined,
                toolName,
                isSynthetic: false,
            }));
            if (!persisted) {
                return undefined;
            }
            return originalAppend(capToolResultForPersistence(persisted, maxToolResultChars));
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
        // Always clear pending tool call state before appending non-tool-result messages.
        // flushPendingToolResults() only inserts synthetic results when allowSyntheticToolResults
        // is true; it always clears the pending map. Without this, providers that disable
        // synthetic results (e.g. OpenAI) accumulate stale pending state when a user message
        // interrupts in-flight tool calls, leaving orphaned tool_use blocks in the transcript
        // that cause API 400 errors on subsequent requests.
        if (pendingState.shouldFlushBeforeNonToolResult(nextRole, toolCalls.length)) {
            flushPendingToolResults();
        }
        // If new tool calls arrive while older ones are pending, flush the old ones first.
        if (pendingState.shouldFlushBeforeNewToolCalls(toolCalls.length)) {
            flushPendingToolResults();
        }
        const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
        if (!finalMessage) {
            return undefined;
        }
        const result = originalAppend(finalMessage);
        const sessionFile = sessionManager.getSessionFile?.();
        if (sessionFile) {
            emitSessionTranscriptUpdate({
                sessionFile,
                sessionKey: opts?.sessionKey,
                message: finalMessage,
                messageId: typeof result === "string" ? result : undefined,
            });
        }
        if (toolCalls.length > 0) {
            pendingState.trackToolCalls(toolCalls);
        }
        return result;
    };
    // Monkey-patch appendMessage with our guarded version.
    sessionManager.appendMessage = guardedAppend;
    return {
        flushPendingToolResults,
        clearPendingToolResults,
        getPendingIds: pendingState.getPendingIds,
    };
}
