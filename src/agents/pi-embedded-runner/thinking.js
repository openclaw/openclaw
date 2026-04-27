import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { formatErrorMessage } from "../../infra/errors.js";
import { log } from "./logger.js";
const THINKING_BLOCK_ERROR_PATTERN = /thinking or redacted_thinking blocks?.* cannot be modified/i;
export const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";
export function isAssistantMessageWithContent(message) {
    return (!!message &&
        typeof message === "object" &&
        message.role === "assistant" &&
        Array.isArray(message.content));
}
function isThinkingBlock(block) {
    return (!!block &&
        typeof block === "object" &&
        (block.type === "thinking" ||
            block.type === "redacted_thinking"));
}
function isSignedThinkingBlock(block) {
    if (!isThinkingBlock(block)) {
        return false;
    }
    const record = block;
    return (record.type === "redacted_thinking" ||
        record.signature != null ||
        record.thinkingSignature != null ||
        record.thought_signature != null);
}
function hasMeaningfulText(block) {
    if (!block || typeof block !== "object" || block.type !== "text") {
        return false;
    }
    return typeof block.text === "string"
        ? block.text.trim().length > 0
        : false;
}
function buildOmittedAssistantReasoningContent() {
    // Provider converters drop blank text blocks; keep this neutral text non-empty so the assistant turn survives replay.
    return [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }];
}
function hasReplayableThinkingSignature(block) {
    if (!isThinkingBlock(block)) {
        return false;
    }
    const record = block;
    const candidates = block.type === "redacted_thinking"
        ? [record.data, record.signature, record.thinkingSignature, record.thought_signature]
        : [record.signature, record.thinkingSignature, record.thought_signature];
    return candidates.some((signature) => {
        return typeof signature === "string" && signature.trim().length > 0;
    });
}
/**
 * Strip thinking blocks with clearly invalid replay signatures.
 *
 * Anthropic and Bedrock reject persisted thinking blocks when the signature is
 * absent, empty, or blank. They are also the authority for opaque signature
 * validity, so this intentionally avoids local length or shape heuristics.
 */
export function stripInvalidThinkingSignatures(messages) {
    let touched = false;
    const out = [];
    for (const message of messages) {
        if (!isAssistantMessageWithContent(message)) {
            out.push(message);
            continue;
        }
        const nextContent = [];
        let changed = false;
        for (const block of message.content) {
            if (!isThinkingBlock(block) || hasReplayableThinkingSignature(block)) {
                nextContent.push(block);
                continue;
            }
            changed = true;
            touched = true;
        }
        if (!changed) {
            out.push(message);
            continue;
        }
        out.push({
            ...message,
            content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent(),
        });
    }
    return touched ? out : messages;
}
/**
 * Strip `type: "thinking"` and `type: "redacted_thinking"` content blocks from
 * all assistant messages except the latest one.
 *
 * Thinking blocks in the latest assistant turn are preserved verbatim so
 * providers that require replay signatures can continue the conversation.
 *
 * If a non-latest assistant message becomes empty after stripping, it is
 * replaced with a synthetic non-empty text block to preserve turn structure
 * through provider adapters that filter blank text blocks.
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export function dropThinkingBlocks(messages) {
    let latestAssistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (isAssistantMessageWithContent(messages[i])) {
            latestAssistantIndex = i;
            break;
        }
    }
    let touched = false;
    const out = [];
    for (let i = 0; i < messages.length; i += 1) {
        const msg = messages[i];
        if (!isAssistantMessageWithContent(msg)) {
            out.push(msg);
            continue;
        }
        if (i === latestAssistantIndex) {
            out.push(msg);
            continue;
        }
        const nextContent = [];
        let changed = false;
        for (const block of msg.content) {
            if (isThinkingBlock(block)) {
                touched = true;
                changed = true;
                continue;
            }
            nextContent.push(block);
        }
        if (!changed) {
            out.push(msg);
            continue;
        }
        const content = nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent();
        out.push({ ...msg, content });
    }
    return touched ? out : messages;
}
function stripAllThinkingBlocks(messages) {
    let touched = false;
    const out = [];
    for (const message of messages) {
        if (!isAssistantMessageWithContent(message)) {
            out.push(message);
            continue;
        }
        const nextContent = message.content.filter((block) => !isThinkingBlock(block));
        if (nextContent.length === message.content.length) {
            out.push(message);
            continue;
        }
        touched = true;
        out.push({
            ...message,
            content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent(),
        });
    }
    return touched ? out : messages;
}
export function assessLastAssistantMessage(message) {
    if (!isAssistantMessageWithContent(message)) {
        return "valid";
    }
    if (message.content.length === 0) {
        return "incomplete-thinking";
    }
    let hasSignedThinking = false;
    let hasUnsignedThinking = false;
    let hasNonThinkingContent = false;
    let hasEmptyTextBlock = false;
    for (const block of message.content) {
        if (!block || typeof block !== "object") {
            return "incomplete-thinking";
        }
        if (isThinkingBlock(block)) {
            if (isSignedThinkingBlock(block)) {
                hasSignedThinking = true;
            }
            else {
                hasUnsignedThinking = true;
            }
            continue;
        }
        hasNonThinkingContent = true;
        if (block.type === "text" && !hasMeaningfulText(block)) {
            hasEmptyTextBlock = true;
        }
    }
    if (hasUnsignedThinking) {
        return "incomplete-thinking";
    }
    if (hasSignedThinking && !hasNonThinkingContent) {
        return "incomplete-text";
    }
    if (hasSignedThinking && hasEmptyTextBlock) {
        return "incomplete-text";
    }
    return "valid";
}
export function sanitizeThinkingForRecovery(messages) {
    if (messages.length === 0) {
        return { messages, prefill: false };
    }
    let lastAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "assistant") {
            lastAssistantIndex = index;
            break;
        }
    }
    if (lastAssistantIndex === -1) {
        return { messages, prefill: false };
    }
    const assessment = assessLastAssistantMessage(messages[lastAssistantIndex]);
    if (assessment === "valid") {
        return { messages, prefill: false };
    }
    if (assessment === "incomplete-text") {
        return { messages, prefill: true };
    }
    return {
        messages: [...messages.slice(0, lastAssistantIndex), ...messages.slice(lastAssistantIndex + 1)],
        prefill: false,
    };
}
function shouldRecoverAnthropicThinkingError(error, sessionMeta) {
    const message = formatErrorMessage(error);
    if (!THINKING_BLOCK_ERROR_PATTERN.test(message)) {
        return false;
    }
    if (sessionMeta.recoveredAnthropicThinking) {
        log.warn(`[session-recovery] Anthropic thinking recovery already attempted: sessionId=${sessionMeta.id}`);
        return false;
    }
    return true;
}
async function pumpStreamWithRecovery(outer, stream, sessionMeta, retry) {
    let yieldedChunk = false;
    try {
        const resolved = stream instanceof Promise ? await stream : stream;
        for await (const chunk of resolved) {
            yieldedChunk = true;
            outer.push(chunk);
        }
        const result = await resolved.result?.();
        return result;
    }
    catch (error) {
        if (!shouldRecoverAnthropicThinkingError(error, sessionMeta)) {
            throw error;
        }
        if (yieldedChunk) {
            log.warn(`[session-recovery] Anthropic thinking error occurred after streaming began; skipping retry to avoid duplicate chunks: sessionId=${sessionMeta.id}`);
            throw error;
        }
        sessionMeta.recoveredAnthropicThinking = true;
        log.warn(`[session-recovery] Anthropic thinking error during stream; retrying once without thinking blocks: sessionId=${sessionMeta.id}`);
        const retryStream = retry();
        const resolvedRetry = retryStream instanceof Promise ? await retryStream : retryStream;
        for await (const chunk of resolvedRetry) {
            outer.push(chunk);
        }
        const result = await resolvedRetry.result?.();
        return result;
    }
}
export function wrapAnthropicStreamWithRecovery(innerStreamFn, sessionMeta) {
    return (model, context, options) => {
        const contextRecord = context;
        const originalMessages = Array.isArray(contextRecord.messages)
            ? contextRecord.messages
            : [];
        const retry = () => {
            const cleanedMessages = stripAllThinkingBlocks(originalMessages);
            const nextContext = {
                ...context,
                messages: cleanedMessages,
            };
            return innerStreamFn(model, nextContext, options);
        };
        const stream = innerStreamFn(model, context, options);
        if (stream instanceof Promise) {
            return stream.catch((error) => {
                if (!shouldRecoverAnthropicThinkingError(error, sessionMeta)) {
                    throw error;
                }
                sessionMeta.recoveredAnthropicThinking = true;
                log.warn(`[session-recovery] Anthropic thinking request rejected; retrying once without thinking blocks: sessionId=${sessionMeta.id}`);
                return retry();
            });
        }
        const outer = createAssistantMessageEventStream();
        const finalResultPromise = pumpStreamWithRecovery(outer, stream, sessionMeta, retry).finally(() => {
            outer.end();
        });
        outer.result = () => finalResultPromise;
        return outer;
    };
}
