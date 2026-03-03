import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";
const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_-]+$/;
function isRawToolCallBlock(block) {
    if (!block || typeof block !== "object") {
        return false;
    }
    const type = block.type;
    return (typeof type === "string" &&
        (type === "toolCall" || type === "toolUse" || type === "functionCall"));
}
function hasToolCallInput(block) {
    const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
    const hasArguments = "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
    return hasInput || hasArguments;
}
function hasNonEmptyStringField(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function hasToolCallId(block) {
    return hasNonEmptyStringField(block.id);
}
function normalizeAllowedToolNames(allowedToolNames) {
    if (!allowedToolNames) {
        return null;
    }
    const normalized = new Set();
    for (const name of allowedToolNames) {
        if (typeof name !== "string") {
            continue;
        }
        const trimmed = name.trim();
        if (trimmed) {
            normalized.add(trimmed.toLowerCase());
        }
    }
    return normalized.size > 0 ? normalized : null;
}
function hasToolCallName(block, allowedToolNames) {
    if (typeof block.name !== "string") {
        return false;
    }
    const trimmed = block.name.trim();
    if (!trimmed) {
        return false;
    }
    if (trimmed.length > TOOL_CALL_NAME_MAX_CHARS || !TOOL_CALL_NAME_RE.test(trimmed)) {
        return false;
    }
    if (!allowedToolNames) {
        return true;
    }
    return allowedToolNames.has(trimmed.toLowerCase());
}
function redactSessionsSpawnAttachmentsArgs(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    const rec = value;
    const raw = rec.attachments;
    if (!Array.isArray(raw)) {
        return value;
    }
    const next = raw.map((item) => {
        if (!item || typeof item !== "object") {
            return item;
        }
        const a = item;
        if (!Object.hasOwn(a, "content")) {
            return item;
        }
        const { content: _content, ...rest } = a;
        return { ...rest, content: "__OPENCLAW_REDACTED__" };
    });
    return { ...rec, attachments: next };
}
function sanitizeToolCallBlock(block) {
    const rawName = typeof block.name === "string" ? block.name : undefined;
    const trimmedName = rawName?.trim();
    const hasTrimmedName = typeof trimmedName === "string" && trimmedName.length > 0;
    const normalizedName = hasTrimmedName ? trimmedName : undefined;
    const nameChanged = hasTrimmedName && rawName !== trimmedName;
    const isSessionsSpawn = normalizedName?.toLowerCase() === "sessions_spawn";
    if (!isSessionsSpawn) {
        if (!nameChanged) {
            return block;
        }
        return { ...block, name: normalizedName };
    }
    // Redact large/sensitive inline attachment content from persisted transcripts.
    // Apply redaction to both `.arguments` and `.input` properties since block structures can vary
    const nextArgs = redactSessionsSpawnAttachmentsArgs(block.arguments);
    const nextInput = redactSessionsSpawnAttachmentsArgs(block.input);
    if (nextArgs === block.arguments && nextInput === block.input && !nameChanged) {
        return block;
    }
    const next = { ...block };
    if (nameChanged && normalizedName) {
        next.name = normalizedName;
    }
    if (nextArgs !== block.arguments || Object.hasOwn(block, "arguments")) {
        next.arguments = nextArgs;
    }
    if (nextInput !== block.input || Object.hasOwn(block, "input")) {
        next.input = nextInput;
    }
    return next;
}
function makeMissingToolResult(params) {
    return {
        role: "toolResult",
        toolCallId: params.toolCallId,
        toolName: params.toolName ?? "unknown",
        content: [
            {
                type: "text",
                text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
            },
        ],
        isError: true,
        timestamp: Date.now(),
    };
}
function trimNonEmptyString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
function normalizeToolResultName(message, fallbackName) {
    const rawToolName = message.toolName;
    const normalizedToolName = trimNonEmptyString(rawToolName);
    if (normalizedToolName) {
        if (rawToolName === normalizedToolName) {
            return message;
        }
        return { ...message, toolName: normalizedToolName };
    }
    const normalizedFallback = trimNonEmptyString(fallbackName);
    if (normalizedFallback) {
        return { ...message, toolName: normalizedFallback };
    }
    if (typeof rawToolName === "string") {
        return { ...message, toolName: "unknown" };
    }
    return message;
}
export { makeMissingToolResult };
export function stripToolResultDetails(messages) {
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
export function repairToolCallInputs(messages, options) {
    let droppedToolCalls = 0;
    let droppedAssistantMessages = 0;
    let changed = false;
    const out = [];
    const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
    for (const msg of messages) {
        if (!msg || typeof msg !== "object") {
            out.push(msg);
            continue;
        }
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
            out.push(msg);
            continue;
        }
        const nextContent = [];
        let droppedInMessage = 0;
        let messageChanged = false;
        for (const block of msg.content) {
            if (isRawToolCallBlock(block) &&
                (!hasToolCallInput(block) ||
                    !hasToolCallId(block) ||
                    !hasToolCallName(block, allowedToolNames))) {
                droppedToolCalls += 1;
                droppedInMessage += 1;
                changed = true;
                messageChanged = true;
                continue;
            }
            if (isRawToolCallBlock(block)) {
                if (block.type === "toolCall" ||
                    block.type === "toolUse" ||
                    block.type === "functionCall") {
                    // Only sanitize (redact) sessions_spawn blocks; all others are passed through
                    // unchanged to preserve provider-specific shapes (e.g. toolUse.input for Anthropic).
                    const blockName = typeof block.name === "string"
                        ? block.name.trim()
                        : undefined;
                    if (blockName?.toLowerCase() === "sessions_spawn") {
                        const sanitized = sanitizeToolCallBlock(block);
                        if (sanitized !== block) {
                            changed = true;
                            messageChanged = true;
                        }
                        nextContent.push(sanitized);
                    }
                    else {
                        if (typeof block.name === "string") {
                            const rawName = block.name;
                            const trimmedName = rawName.trim();
                            if (rawName !== trimmedName && trimmedName) {
                                const renamed = { ...block, name: trimmedName };
                                nextContent.push(renamed);
                                changed = true;
                                messageChanged = true;
                            }
                            else {
                                nextContent.push(block);
                            }
                        }
                        else {
                            nextContent.push(block);
                        }
                    }
                    continue;
                }
            }
            else {
                nextContent.push(block);
            }
        }
        if (droppedInMessage > 0) {
            if (nextContent.length === 0) {
                droppedAssistantMessages += 1;
                changed = true;
                continue;
            }
            out.push({ ...msg, content: nextContent });
            continue;
        }
        if (messageChanged) {
            out.push({ ...msg, content: nextContent });
            continue;
        }
        out.push(msg);
    }
    return {
        messages: changed ? out : messages,
        droppedToolCalls,
        droppedAssistantMessages,
    };
}
export function sanitizeToolCallInputs(messages, options) {
    return repairToolCallInputs(messages, options).messages;
}
export function sanitizeToolUseResultPairing(messages) {
    return repairToolUseResultPairing(messages).messages;
}
export function repairToolUseResultPairing(messages) {
    // Anthropic (and Cloud Code Assist) reject transcripts where assistant tool calls are not
    // immediately followed by matching tool results. Session files can end up with results
    // displaced (e.g. after user turns) or duplicated. Repair by:
    // - moving matching toolResult messages directly after their assistant toolCall turn
    // - inserting synthetic error toolResults for missing ids
    // - dropping duplicate toolResults for the same id (anywhere in the transcript)
    const out = [];
    const added = [];
    const seenToolResultIds = new Set();
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
        if (id) {
            seenToolResultIds.add(id);
        }
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
            // Tool results must only appear directly after the matching assistant tool call turn.
            // Any "free-floating" toolResult entries in session history can make strict providers
            // (Anthropic-compatible APIs, MiniMax, Cloud Code Assist) reject the entire request.
            if (role !== "toolResult") {
                out.push(msg);
            }
            else {
                droppedOrphanCount += 1;
                changed = true;
            }
            continue;
        }
        const assistant = msg;
        // Skip tool call extraction for aborted or errored assistant messages.
        // When stopReason is "error" or "aborted", the tool_use blocks may be incomplete
        // (e.g., partialJson: true) and should not have synthetic tool_results created.
        // Creating synthetic results for incomplete tool calls causes API 400 errors:
        // "unexpected tool_use_id found in tool_result blocks"
        // See: https://github.com/openclaw/openclaw/issues/4597
        const stopReason = assistant.stopReason;
        if (stopReason === "error" || stopReason === "aborted") {
            out.push(msg);
            continue;
        }
        const toolCalls = extractToolCallsFromAssistant(assistant);
        if (toolCalls.length === 0) {
            out.push(msg);
            continue;
        }
        const toolCallIds = new Set(toolCalls.map((t) => t.id));
        const toolCallNamesById = new Map(toolCalls.map((t) => [t.id, t.name]));
        const spanResultsById = new Map();
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
                break;
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
                    if (normalizedToolResult !== toolResult) {
                        changed = true;
                    }
                    if (!spanResultsById.has(id)) {
                        spanResultsById.set(id, normalizedToolResult);
                    }
                    continue;
                }
            }
            // Drop tool results that don't match the current assistant tool calls.
            if (nextRole !== "toolResult") {
                remainder.push(next);
            }
            else {
                droppedOrphanCount += 1;
                changed = true;
            }
        }
        out.push(msg);
        if (spanResultsById.size > 0 && remainder.length > 0) {
            moved = true;
            changed = true;
        }
        for (const call of toolCalls) {
            const existing = spanResultsById.get(call.id);
            if (existing) {
                pushToolResult(existing);
            }
            else {
                const missing = makeMissingToolResult({
                    toolCallId: call.id,
                    toolName: call.name,
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
        moved: changedOrMoved,
    };
}
