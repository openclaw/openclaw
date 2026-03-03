const CHARS_PER_TOKEN_ESTIMATE = 4;
// Keep a conservative input budget to absorb tokenizer variance and provider framing overhead.
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;
const IMAGE_CHAR_ESTIMATE = 8000;
export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
const CONTEXT_LIMIT_TRUNCATION_SUFFIX = `\n${CONTEXT_LIMIT_TRUNCATION_NOTICE}`;
export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER = "[compacted: tool output removed to free context]";
function isTextBlock(block) {
    return !!block && typeof block === "object" && block.type === "text";
}
function isImageBlock(block) {
    return !!block && typeof block === "object" && block.type === "image";
}
function estimateUnknownChars(value) {
    if (typeof value === "string") {
        return value.length;
    }
    if (value === undefined) {
        return 0;
    }
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === "string" ? serialized.length : 0;
    }
    catch {
        return 256;
    }
}
function isToolResultMessage(msg) {
    const role = msg.role;
    const type = msg.type;
    return role === "toolResult" || role === "tool" || type === "toolResult";
}
function getToolResultContent(msg) {
    if (!isToolResultMessage(msg)) {
        return [];
    }
    const content = msg.content;
    if (typeof content === "string") {
        return [{ type: "text", text: content }];
    }
    return Array.isArray(content) ? content : [];
}
function getToolResultText(msg) {
    const content = getToolResultContent(msg);
    const chunks = [];
    for (const block of content) {
        if (isTextBlock(block)) {
            chunks.push(block.text);
        }
    }
    return chunks.join("\n");
}
function estimateMessageChars(msg) {
    if (!msg || typeof msg !== "object") {
        return 0;
    }
    if (msg.role === "user") {
        const content = msg.content;
        if (typeof content === "string") {
            return content.length;
        }
        let chars = 0;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (isTextBlock(block)) {
                    chars += block.text.length;
                }
                else if (isImageBlock(block)) {
                    chars += IMAGE_CHAR_ESTIMATE;
                }
                else {
                    chars += estimateUnknownChars(block);
                }
            }
        }
        return chars;
    }
    if (msg.role === "assistant") {
        let chars = 0;
        const content = msg.content;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (!block || typeof block !== "object") {
                    continue;
                }
                const typed = block;
                if (typed.type === "text" && typeof typed.text === "string") {
                    chars += typed.text.length;
                }
                else if (typed.type === "thinking" && typeof typed.thinking === "string") {
                    chars += typed.thinking.length;
                }
                else if (typed.type === "toolCall") {
                    try {
                        chars += JSON.stringify(typed.arguments ?? {}).length;
                    }
                    catch {
                        chars += 128;
                    }
                }
                else {
                    chars += estimateUnknownChars(block);
                }
            }
        }
        return chars;
    }
    if (isToolResultMessage(msg)) {
        let chars = 0;
        const content = getToolResultContent(msg);
        for (const block of content) {
            if (isTextBlock(block)) {
                chars += block.text.length;
            }
            else if (isImageBlock(block)) {
                chars += IMAGE_CHAR_ESTIMATE;
            }
            else {
                chars += estimateUnknownChars(block);
            }
        }
        const details = msg.details;
        chars += estimateUnknownChars(details);
        const weightedChars = Math.ceil(chars * (CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE));
        return Math.max(chars, weightedChars);
    }
    return 256;
}
function estimateContextChars(messages) {
    return messages.reduce((sum, msg) => sum + estimateMessageChars(msg), 0);
}
function truncateTextToBudget(text, maxChars) {
    if (text.length <= maxChars) {
        return text;
    }
    if (maxChars <= 0) {
        return CONTEXT_LIMIT_TRUNCATION_NOTICE;
    }
    const bodyBudget = Math.max(0, maxChars - CONTEXT_LIMIT_TRUNCATION_SUFFIX.length);
    if (bodyBudget <= 0) {
        return CONTEXT_LIMIT_TRUNCATION_NOTICE;
    }
    let cutPoint = bodyBudget;
    const newline = text.lastIndexOf("\n", bodyBudget);
    if (newline > bodyBudget * 0.7) {
        cutPoint = newline;
    }
    return text.slice(0, cutPoint) + CONTEXT_LIMIT_TRUNCATION_SUFFIX;
}
function replaceToolResultText(msg, text) {
    const content = msg.content;
    const replacementContent = typeof content === "string" || content === undefined ? text : [{ type: "text", text }];
    const sourceRecord = msg;
    const { details: _details, ...rest } = sourceRecord;
    return {
        ...rest,
        content: replacementContent,
    };
}
function truncateToolResultToChars(msg, maxChars) {
    if (!isToolResultMessage(msg)) {
        return msg;
    }
    const estimatedChars = estimateMessageChars(msg);
    if (estimatedChars <= maxChars) {
        return msg;
    }
    const rawText = getToolResultText(msg);
    if (!rawText) {
        return replaceToolResultText(msg, CONTEXT_LIMIT_TRUNCATION_NOTICE);
    }
    const truncatedText = truncateTextToBudget(rawText, maxChars);
    return replaceToolResultText(msg, truncatedText);
}
function compactExistingToolResultsInPlace(params) {
    const { messages, charsNeeded } = params;
    if (charsNeeded <= 0) {
        return 0;
    }
    let reduced = 0;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!isToolResultMessage(msg)) {
            continue;
        }
        const before = estimateMessageChars(msg);
        if (before <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
            continue;
        }
        const compacted = replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
        applyMessageMutationInPlace(msg, compacted);
        const after = estimateMessageChars(msg);
        if (after >= before) {
            continue;
        }
        reduced += before - after;
        if (reduced >= charsNeeded) {
            break;
        }
    }
    return reduced;
}
function applyMessageMutationInPlace(target, source) {
    if (target === source) {
        return;
    }
    const targetRecord = target;
    const sourceRecord = source;
    for (const key of Object.keys(targetRecord)) {
        if (!(key in sourceRecord)) {
            delete targetRecord[key];
        }
    }
    Object.assign(targetRecord, sourceRecord);
}
function enforceToolResultContextBudgetInPlace(params) {
    const { messages, contextBudgetChars, maxSingleToolResultChars } = params;
    // Ensure each tool result has an upper bound before considering total context usage.
    for (const message of messages) {
        if (!isToolResultMessage(message)) {
            continue;
        }
        const truncated = truncateToolResultToChars(message, maxSingleToolResultChars);
        applyMessageMutationInPlace(message, truncated);
    }
    let currentChars = estimateContextChars(messages);
    if (currentChars <= contextBudgetChars) {
        return;
    }
    // Compact oldest tool outputs first until the context is back under budget.
    compactExistingToolResultsInPlace({
        messages,
        charsNeeded: currentChars - contextBudgetChars,
    });
}
export function installToolResultContextGuard(params) {
    const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
    const contextBudgetChars = Math.max(1024, Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO));
    const maxSingleToolResultChars = Math.max(1024, Math.floor(contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE));
    // Agent.transformContext is private in pi-coding-agent, so access it via a
    // narrow runtime view to keep callsites type-safe while preserving behavior.
    const mutableAgent = params.agent;
    const originalTransformContext = mutableAgent.transformContext;
    mutableAgent.transformContext = (async (messages, signal) => {
        const transformed = originalTransformContext
            ? await originalTransformContext.call(mutableAgent, messages, signal)
            : messages;
        const contextMessages = Array.isArray(transformed) ? transformed : messages;
        enforceToolResultContextBudgetInPlace({
            messages: contextMessages,
            contextBudgetChars,
            maxSingleToolResultChars,
        });
        return contextMessages;
    });
    return () => {
        mutableAgent.transformContext = originalTransformContext;
    };
}
