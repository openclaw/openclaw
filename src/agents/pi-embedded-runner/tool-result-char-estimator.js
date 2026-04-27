export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;
const IMAGE_CHAR_ESTIMATE = 8_000;
function isTextBlock(block) {
    return (!!block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string");
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
export function isToolResultMessage(msg) {
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
function estimateContentBlockChars(content) {
    let chars = 0;
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
    return chars;
}
export function getToolResultText(msg) {
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
        if (Array.isArray(content)) {
            return estimateContentBlockChars(content);
        }
        return 0;
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
        const content = getToolResultContent(msg);
        let chars = estimateContentBlockChars(content);
        const details = msg.details;
        chars += estimateUnknownChars(details);
        const weightedChars = Math.ceil(chars * (CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE));
        return Math.max(chars, weightedChars);
    }
    return 256;
}
export function createMessageCharEstimateCache() {
    return new WeakMap();
}
export function estimateMessageCharsCached(msg, cache) {
    const hit = cache.get(msg);
    if (hit !== undefined) {
        return hit;
    }
    const estimated = estimateMessageChars(msg);
    cache.set(msg, estimated);
    return estimated;
}
export function estimateContextChars(messages, cache) {
    return messages.reduce((sum, msg) => sum + estimateMessageCharsCached(msg, cache), 0);
}
export function invalidateMessageCharsCacheEntry(cache, msg) {
    cache.delete(msg);
}
