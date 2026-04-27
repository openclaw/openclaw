import { visitObjectContentBlocks } from "../../../shared/message-content-blocks.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { validateAnthropicTurns, validateGeminiTurns } from "../../pi-embedded-helpers.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import { extractToolCallsFromAssistant, sanitizeToolCallIdsForCloudCodeAssist, } from "../../tool-call-id.js";
import { hasUnredactedSessionsSpawnAttachments } from "../../tool-call-shared.js";
import { normalizeToolName } from "../../tool-policy.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";
function resolveCaseInsensitiveAllowedToolName(rawName, allowedToolNames) {
    if (!allowedToolNames || allowedToolNames.size === 0) {
        return null;
    }
    const folded = normalizeLowercaseStringOrEmpty(rawName);
    let caseInsensitiveMatch = null;
    for (const name of allowedToolNames) {
        if (normalizeLowercaseStringOrEmpty(name) !== folded) {
            continue;
        }
        if (caseInsensitiveMatch && caseInsensitiveMatch !== name) {
            return null;
        }
        caseInsensitiveMatch = name;
    }
    return caseInsensitiveMatch;
}
function resolveExactAllowedToolName(rawName, allowedToolNames) {
    if (!allowedToolNames || allowedToolNames.size === 0) {
        return null;
    }
    if (allowedToolNames.has(rawName)) {
        return rawName;
    }
    const normalized = normalizeToolName(rawName);
    if (allowedToolNames.has(normalized)) {
        return normalized;
    }
    return (resolveCaseInsensitiveAllowedToolName(rawName, allowedToolNames) ??
        resolveCaseInsensitiveAllowedToolName(normalized, allowedToolNames));
}
function buildStructuredToolNameCandidates(rawName) {
    const trimmed = rawName.trim();
    if (!trimmed) {
        return [];
    }
    const candidates = [];
    const seen = new Set();
    const addCandidate = (value) => {
        const candidate = value.trim();
        if (!candidate || seen.has(candidate)) {
            return;
        }
        seen.add(candidate);
        candidates.push(candidate);
    };
    addCandidate(trimmed);
    addCandidate(normalizeToolName(trimmed));
    const normalizedDelimiter = trimmed.replace(/\//g, ".");
    addCandidate(normalizedDelimiter);
    addCandidate(normalizeToolName(normalizedDelimiter));
    const segments = normalizedDelimiter
        .split(".")
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (segments.length > 1) {
        for (let index = 1; index < segments.length; index += 1) {
            const suffix = segments.slice(index).join(".");
            addCandidate(suffix);
            addCandidate(normalizeToolName(suffix));
        }
    }
    return candidates;
}
function resolveStructuredAllowedToolName(rawName, allowedToolNames) {
    if (!allowedToolNames || allowedToolNames.size === 0) {
        return null;
    }
    const candidateNames = buildStructuredToolNameCandidates(rawName);
    for (const candidate of candidateNames) {
        if (allowedToolNames.has(candidate)) {
            return candidate;
        }
    }
    for (const candidate of candidateNames) {
        const caseInsensitiveMatch = resolveCaseInsensitiveAllowedToolName(candidate, allowedToolNames);
        if (caseInsensitiveMatch) {
            return caseInsensitiveMatch;
        }
    }
    return null;
}
function inferToolNameFromToolCallId(rawId, allowedToolNames) {
    if (!rawId || !allowedToolNames || allowedToolNames.size === 0) {
        return null;
    }
    const id = rawId.trim();
    if (!id) {
        return null;
    }
    const candidateTokens = new Set();
    const addToken = (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
            return;
        }
        candidateTokens.add(trimmed);
        candidateTokens.add(trimmed.replace(/[:._/-]\d+$/, ""));
        candidateTokens.add(trimmed.replace(/\d+$/, ""));
        const normalizedDelimiter = trimmed.replace(/\//g, ".");
        candidateTokens.add(normalizedDelimiter);
        candidateTokens.add(normalizedDelimiter.replace(/[:._-]\d+$/, ""));
        candidateTokens.add(normalizedDelimiter.replace(/\d+$/, ""));
        for (const prefixPattern of [/^functions?[._-]?/i, /^tools?[._-]?/i]) {
            const stripped = normalizedDelimiter.replace(prefixPattern, "");
            if (stripped !== normalizedDelimiter) {
                candidateTokens.add(stripped);
                candidateTokens.add(stripped.replace(/[:._-]\d+$/, ""));
                candidateTokens.add(stripped.replace(/\d+$/, ""));
            }
        }
    };
    const preColon = id.split(":")[0] ?? id;
    for (const seed of [id, preColon]) {
        addToken(seed);
    }
    let singleMatch = null;
    for (const candidate of candidateTokens) {
        const matched = resolveStructuredAllowedToolName(candidate, allowedToolNames);
        if (!matched) {
            continue;
        }
        if (singleMatch && singleMatch !== matched) {
            return null;
        }
        singleMatch = matched;
    }
    return singleMatch;
}
function looksLikeMalformedToolNameCounter(rawName) {
    const normalizedDelimiter = rawName.trim().replace(/\//g, ".");
    return (/^(?:functions?|tools?)[._-]?/i.test(normalizedDelimiter) &&
        /(?:[:._-]\d+|\d+)$/.test(normalizedDelimiter));
}
function normalizeToolCallNameForDispatch(rawName, allowedToolNames, rawToolCallId) {
    const trimmed = rawName.trim();
    if (!trimmed) {
        return inferToolNameFromToolCallId(rawToolCallId, allowedToolNames) ?? rawName;
    }
    if (!allowedToolNames || allowedToolNames.size === 0) {
        return trimmed;
    }
    const exact = resolveExactAllowedToolName(trimmed, allowedToolNames);
    if (exact) {
        return exact;
    }
    const inferredFromName = inferToolNameFromToolCallId(trimmed, allowedToolNames);
    if (inferredFromName) {
        return inferredFromName;
    }
    if (looksLikeMalformedToolNameCounter(trimmed)) {
        return trimmed;
    }
    return resolveStructuredAllowedToolName(trimmed, allowedToolNames) ?? trimmed;
}
function isToolCallBlockType(type) {
    return type === "toolCall" || type === "toolUse" || type === "functionCall";
}
const REPLAY_TOOL_CALL_NAME_MAX_CHARS = 64;
function isThinkingLikeReplayBlock(block) {
    if (!block || typeof block !== "object") {
        return false;
    }
    const type = block.type;
    return type === "thinking" || type === "redacted_thinking";
}
function isReplaySafeThinkingTurn(content, allowedToolNames) {
    const seenToolCallIds = new Set();
    for (const block of content) {
        if (!isReplayToolCallBlock(block)) {
            continue;
        }
        const replayBlock = block;
        const toolCallId = typeof replayBlock.id === "string" ? replayBlock.id.trim() : "";
        if (!replayToolCallHasInput(replayBlock) ||
            !toolCallId ||
            seenToolCallIds.has(toolCallId) ||
            hasUnredactedSessionsSpawnAttachments(replayBlock)) {
            return false;
        }
        seenToolCallIds.add(toolCallId);
        const rawName = typeof replayBlock.name === "string" ? replayBlock.name : "";
        const resolvedName = resolveReplayToolCallName(rawName, toolCallId, allowedToolNames);
        if (!resolvedName || replayBlock.name !== resolvedName) {
            return false;
        }
    }
    return true;
}
function isReplayToolCallBlock(block) {
    if (!block || typeof block !== "object") {
        return false;
    }
    return isToolCallBlockType(block.type);
}
function replayToolCallHasInput(block) {
    const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
    const hasArguments = "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
    return hasInput || hasArguments;
}
function replayToolCallNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function resolveReplayToolCallName(rawName, rawId, allowedToolNames) {
    if (rawName.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS * 2) {
        return null;
    }
    const normalized = normalizeToolCallNameForDispatch(rawName, allowedToolNames, rawId);
    const trimmed = normalized.trim();
    if (!trimmed || trimmed.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS || /\s/.test(trimmed)) {
        return null;
    }
    if (!allowedToolNames || allowedToolNames.size === 0) {
        return trimmed;
    }
    return resolveExactAllowedToolName(trimmed, allowedToolNames);
}
function sanitizeReplayToolCallInputs(messages, allowedToolNames, allowProviderOwnedThinkingReplay) {
    let changed = false;
    let droppedAssistantMessages = 0;
    const out = [];
    const claimedReplaySafeToolCallIds = new Set();
    for (const message of messages) {
        if (!message || typeof message !== "object" || message.role !== "assistant") {
            out.push(message);
            continue;
        }
        if (!Array.isArray(message.content)) {
            out.push(message);
            continue;
        }
        if (allowProviderOwnedThinkingReplay &&
            message.content.some((block) => isThinkingLikeReplayBlock(block)) &&
            message.content.some((block) => isReplayToolCallBlock(block))) {
            const replaySafeToolCalls = extractToolCallsFromAssistant(message);
            if (isReplaySafeThinkingTurn(message.content, allowedToolNames) &&
                replaySafeToolCalls.every((toolCall) => !claimedReplaySafeToolCallIds.has(toolCall.id))) {
                for (const toolCall of replaySafeToolCalls) {
                    claimedReplaySafeToolCallIds.add(toolCall.id);
                }
                out.push(message);
            }
            else {
                changed = true;
                droppedAssistantMessages += 1;
            }
            continue;
        }
        const nextContent = [];
        let messageChanged = false;
        for (const block of message.content) {
            if (!isReplayToolCallBlock(block)) {
                nextContent.push(block);
                continue;
            }
            const replayBlock = block;
            if (!replayToolCallHasInput(replayBlock) || !replayToolCallNonEmptyString(replayBlock.id)) {
                changed = true;
                messageChanged = true;
                continue;
            }
            const rawName = typeof replayBlock.name === "string" ? replayBlock.name : "";
            const resolvedName = resolveReplayToolCallName(rawName, replayBlock.id, allowedToolNames);
            if (!resolvedName) {
                changed = true;
                messageChanged = true;
                continue;
            }
            if (replayBlock.name !== resolvedName) {
                nextContent.push({ ...block, name: resolvedName });
                changed = true;
                messageChanged = true;
                continue;
            }
            nextContent.push(block);
        }
        if (messageChanged) {
            changed = true;
            if (nextContent.length > 0) {
                out.push({ ...message, content: nextContent });
            }
            else {
                droppedAssistantMessages += 1;
            }
            continue;
        }
        out.push(message);
    }
    return {
        messages: changed ? out : messages,
        droppedAssistantMessages,
    };
}
function extractAnthropicReplayToolResultIds(block) {
    const ids = [];
    for (const value of [block.toolUseId, block.toolCallId, block.tool_use_id, block.tool_call_id]) {
        if (typeof value !== "string") {
            continue;
        }
        const trimmed = value.trim();
        if (!trimmed || ids.includes(trimmed)) {
            continue;
        }
        ids.push(trimmed);
    }
    return ids;
}
function isSignedThinkingReplayAssistantSpan(message) {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
        return false;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return false;
    }
    return (content.some((block) => isThinkingLikeReplayBlock(block)) &&
        content.some((block) => isReplayToolCallBlock(block)));
}
function sanitizeAnthropicReplayToolResults(messages, options) {
    let changed = false;
    const out = [];
    const disallowEmbeddedUserToolResultsForSignedThinkingReplay = options?.disallowEmbeddedUserToolResultsForSignedThinkingReplay === true;
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || typeof message !== "object" || message.role !== "user") {
            out.push(message);
            continue;
        }
        if (!Array.isArray(message.content)) {
            out.push(message);
            continue;
        }
        const previous = messages[index - 1];
        const shouldStripEmbeddedToolResults = disallowEmbeddedUserToolResultsForSignedThinkingReplay &&
            isSignedThinkingReplayAssistantSpan(previous);
        const validToolUseIds = new Set();
        if (previous && typeof previous === "object" && previous.role === "assistant") {
            const previousContent = previous.content;
            if (Array.isArray(previousContent)) {
                for (const block of previousContent) {
                    if (!block || typeof block !== "object") {
                        continue;
                    }
                    const typedBlock = block;
                    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
                        continue;
                    }
                    const trimmedId = typedBlock.id.trim();
                    if (trimmedId) {
                        validToolUseIds.add(trimmedId);
                    }
                }
            }
        }
        const nextContent = message.content.filter((block) => {
            if (!block || typeof block !== "object") {
                return true;
            }
            const typedBlock = block;
            if (typedBlock.type !== "toolResult" && typedBlock.type !== "tool") {
                return true;
            }
            if (shouldStripEmbeddedToolResults) {
                changed = true;
                return false;
            }
            const resultIds = extractAnthropicReplayToolResultIds(typedBlock);
            if (resultIds.length === 0) {
                changed = true;
                return false;
            }
            return validToolUseIds.size > 0 && resultIds.some((id) => validToolUseIds.has(id));
        });
        if (nextContent.length === message.content.length) {
            out.push(message);
            continue;
        }
        changed = true;
        if (nextContent.length > 0) {
            out.push({ ...message, content: nextContent });
            continue;
        }
        out.push({
            ...message,
            content: [{ type: "text", text: "[tool results omitted]" }],
        });
    }
    return changed ? out : messages;
}
function normalizeToolCallIdsInMessage(message) {
    if (!message || typeof message !== "object") {
        return;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return;
    }
    const usedIds = new Set();
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const typedBlock = block;
        if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
            continue;
        }
        const trimmedId = typedBlock.id.trim();
        if (!trimmedId) {
            continue;
        }
        usedIds.add(trimmedId);
    }
    let fallbackIndex = 1;
    const assignedIds = new Set();
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const typedBlock = block;
        if (!isToolCallBlockType(typedBlock.type)) {
            continue;
        }
        if (typeof typedBlock.id === "string") {
            const trimmedId = typedBlock.id.trim();
            if (trimmedId) {
                if (!assignedIds.has(trimmedId)) {
                    if (typedBlock.id !== trimmedId) {
                        typedBlock.id = trimmedId;
                    }
                    assignedIds.add(trimmedId);
                    continue;
                }
            }
        }
        let fallbackId = "";
        while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
            fallbackId = `call_auto_${fallbackIndex++}`;
        }
        typedBlock.id = fallbackId;
        usedIds.add(fallbackId);
        assignedIds.add(fallbackId);
    }
}
function trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames) {
    visitObjectContentBlocks(message, (block) => {
        const typedBlock = block;
        if (!isToolCallBlockType(typedBlock.type)) {
            return;
        }
        const rawId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
        if (typeof typedBlock.name === "string") {
            const normalized = normalizeToolCallNameForDispatch(typedBlock.name, allowedToolNames, rawId);
            if (normalized !== typedBlock.name) {
                typedBlock.name = normalized;
            }
            return;
        }
        const inferred = inferToolNameFromToolCallId(rawId, allowedToolNames);
        if (inferred) {
            typedBlock.name = inferred;
        }
    });
    normalizeToolCallIdsInMessage(message);
}
function classifyToolCallMessage(message, allowedToolNames) {
    if (!message || typeof message !== "object" || !allowedToolNames || allowedToolNames.size === 0) {
        return { kind: "none" };
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return { kind: "none" };
    }
    let unknownToolName;
    let sawToolCall = false;
    let sawAllowedToolCall = false;
    let sawIncompleteToolCall = false;
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const typedBlock = block;
        if (!isToolCallBlockType(typedBlock.type)) {
            continue;
        }
        sawToolCall = true;
        const rawName = typeof typedBlock.name === "string" ? typedBlock.name.trim() : "";
        if (!rawName) {
            sawIncompleteToolCall = true;
            continue;
        }
        if (resolveExactAllowedToolName(rawName, allowedToolNames)) {
            sawAllowedToolCall = true;
            continue;
        }
        const normalizedUnknownToolName = normalizeToolName(rawName);
        if (!unknownToolName) {
            unknownToolName = normalizedUnknownToolName;
            continue;
        }
        if (unknownToolName !== normalizedUnknownToolName) {
            sawIncompleteToolCall = true;
        }
    }
    if (!sawToolCall) {
        return { kind: "none" };
    }
    if (sawAllowedToolCall) {
        return { kind: "allowed" };
    }
    if (sawIncompleteToolCall) {
        return { kind: "incomplete" };
    }
    return unknownToolName ? { kind: "unknown", toolName: unknownToolName } : { kind: "incomplete" };
}
function rewriteUnknownToolLoopMessage(message, toolName) {
    if (!message || typeof message !== "object") {
        return;
    }
    message.content = [
        {
            type: "text",
            text: `I can't use the tool "${toolName}" here because it isn't available. I need to stop retrying it and answer without that tool.`,
        },
    ];
}
function guardUnknownToolLoopInMessage(message, state, params) {
    const threshold = params.threshold;
    if (threshold === undefined || threshold <= 0) {
        return false;
    }
    const toolCallState = classifyToolCallMessage(message, params.allowedToolNames);
    if (toolCallState.kind === "allowed") {
        if (params.resetOnAllowedTool === true) {
            state.lastUnknownToolName = undefined;
            state.count = 0;
        }
        return false;
    }
    if (toolCallState.kind !== "unknown") {
        if (params.countAttempt && params.resetOnMissingUnknownTool !== false) {
            state.lastUnknownToolName = undefined;
            state.count = 0;
        }
        return false;
    }
    const unknownToolName = toolCallState.toolName;
    if (!params.countAttempt) {
        if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
            rewriteUnknownToolLoopMessage(message, unknownToolName);
        }
        return false;
    }
    if (message && typeof message === "object") {
        if (state.countedMessages.has(message)) {
            if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
                rewriteUnknownToolLoopMessage(message, unknownToolName);
            }
            return true;
        }
        state.countedMessages.add(message);
    }
    if (state.lastUnknownToolName === unknownToolName) {
        state.count += 1;
    }
    else {
        state.lastUnknownToolName = unknownToolName;
        state.count = 1;
    }
    if (state.count > threshold) {
        rewriteUnknownToolLoopMessage(message, unknownToolName);
    }
    return true;
}
function wrapStreamTrimToolCallNames(stream, allowedToolNames, options) {
    const unknownToolGuardState = options?.state ?? {
        count: 0,
        countedMessages: new WeakSet(),
    };
    let streamAttemptAlreadyCounted = false;
    const originalResult = stream.result.bind(stream);
    stream.result = async () => {
        const message = await originalResult();
        trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames);
        guardUnknownToolLoopInMessage(message, unknownToolGuardState, {
            allowedToolNames,
            threshold: options?.unknownToolThreshold,
            countAttempt: !streamAttemptAlreadyCounted,
            resetOnAllowedTool: true,
        });
        return message;
    };
    wrapStreamObjectEvents(stream, (event) => {
        trimWhitespaceFromToolCallNamesInMessage(event.partial, allowedToolNames);
        trimWhitespaceFromToolCallNamesInMessage(event.message, allowedToolNames);
        if (event.message && typeof event.message === "object") {
            const countedStreamAttempt = guardUnknownToolLoopInMessage(event.message, unknownToolGuardState, {
                allowedToolNames,
                threshold: options?.unknownToolThreshold,
                countAttempt: !streamAttemptAlreadyCounted,
                resetOnAllowedTool: true,
                resetOnMissingUnknownTool: false,
            });
            streamAttemptAlreadyCounted ||= countedStreamAttempt;
        }
        guardUnknownToolLoopInMessage(event.partial, unknownToolGuardState, {
            allowedToolNames,
            threshold: options?.unknownToolThreshold,
            countAttempt: false,
        });
    });
    return stream;
}
export function wrapStreamFnTrimToolCallNames(baseFn, allowedToolNames, guardOptions) {
    const unknownToolGuardState = {
        count: 0,
        countedMessages: new WeakSet(),
    };
    return (model, context, streamOptions) => {
        const maybeStream = baseFn(model, context, streamOptions);
        if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
            return Promise.resolve(maybeStream).then((stream) => wrapStreamTrimToolCallNames(stream, allowedToolNames, {
                unknownToolThreshold: guardOptions?.unknownToolThreshold,
                state: unknownToolGuardState,
            }));
        }
        return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames, {
            unknownToolThreshold: guardOptions?.unknownToolThreshold,
            state: unknownToolGuardState,
        });
    };
}
export function sanitizeReplayToolCallIdsForStream(params) {
    const sanitized = sanitizeToolCallIdsForCloudCodeAssist(params.messages, params.mode, {
        preserveNativeAnthropicToolUseIds: params.preserveNativeAnthropicToolUseIds,
        preserveReplaySafeThinkingToolCallIds: params.preserveReplaySafeThinkingToolCallIds,
        allowedToolNames: params.allowedToolNames,
    });
    if (!params.repairToolUseResultPairing) {
        return sanitized;
    }
    return sanitizeToolUseResultPairing(sanitized);
}
export function wrapStreamFnSanitizeMalformedToolCalls(baseFn, allowedToolNames, transcriptPolicy) {
    return (model, context, options) => {
        const ctx = context;
        const messages = ctx?.messages;
        if (!Array.isArray(messages)) {
            return baseFn(model, context, options);
        }
        const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
            modelApi: model?.api,
            policy: {
                validateAnthropicTurns: transcriptPolicy?.validateAnthropicTurns === true,
                preserveSignatures: transcriptPolicy?.preserveSignatures === true,
                dropThinkingBlocks: transcriptPolicy?.dropThinkingBlocks === true,
            },
        });
        const sanitized = sanitizeReplayToolCallInputs(messages, allowedToolNames, allowProviderOwnedThinkingReplay);
        const replayInputsChanged = sanitized.messages !== messages;
        let nextMessages = replayInputsChanged
            ? sanitizeToolUseResultPairing(sanitized.messages)
            : sanitized.messages;
        if (transcriptPolicy?.validateAnthropicTurns) {
            nextMessages = sanitizeAnthropicReplayToolResults(nextMessages, {
                disallowEmbeddedUserToolResultsForSignedThinkingReplay: allowProviderOwnedThinkingReplay,
            });
        }
        if (nextMessages === messages) {
            return baseFn(model, context, options);
        }
        if (sanitized.droppedAssistantMessages > 0 || transcriptPolicy?.validateAnthropicTurns) {
            if (transcriptPolicy?.validateGeminiTurns) {
                nextMessages = validateGeminiTurns(nextMessages);
            }
            if (transcriptPolicy?.validateAnthropicTurns) {
                nextMessages = validateAnthropicTurns(nextMessages);
            }
        }
        const nextContext = {
            ...context,
            messages: nextMessages,
        };
        return baseFn(model, nextContext, options);
    };
}
