import { makeToolPrunablePredicate } from "./tools.js";
const CHARS_PER_TOKEN_ESTIMATE = 4;
// We currently skip pruning tool results that contain images. Still, we count them (approx.) so
// we start trimming prunable tool results earlier when image-heavy context is consuming the window.
const IMAGE_CHAR_ESTIMATE = 8000;
function asText(text) {
    return { type: "text", text };
}
function collectTextSegments(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === "text") {
            parts.push(block.text);
        }
    }
    return parts;
}
function estimateJoinedTextLength(parts) {
    if (parts.length === 0) {
        return 0;
    }
    let len = 0;
    for (const p of parts) {
        len += p.length;
    }
    // Joined with "\n" separators between blocks.
    len += Math.max(0, parts.length - 1);
    return len;
}
function takeHeadFromJoinedText(parts, maxChars) {
    if (maxChars <= 0 || parts.length === 0) {
        return "";
    }
    let remaining = maxChars;
    let out = "";
    for (let i = 0; i < parts.length && remaining > 0; i++) {
        if (i > 0) {
            out += "\n";
            remaining -= 1;
            if (remaining <= 0) {
                break;
            }
        }
        const p = parts[i];
        if (p.length <= remaining) {
            out += p;
            remaining -= p.length;
        }
        else {
            out += p.slice(0, remaining);
            remaining = 0;
        }
    }
    return out;
}
function takeTailFromJoinedText(parts, maxChars) {
    if (maxChars <= 0 || parts.length === 0) {
        return "";
    }
    let remaining = maxChars;
    const out = [];
    for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
        const p = parts[i];
        if (p.length <= remaining) {
            out.push(p);
            remaining -= p.length;
        }
        else {
            out.push(p.slice(p.length - remaining));
            remaining = 0;
            break;
        }
        if (remaining > 0 && i > 0) {
            out.push("\n");
            remaining -= 1;
        }
    }
    out.reverse();
    return out.join("");
}
function hasImageBlocks(content) {
    for (const block of content) {
        if (block.type === "image") {
            return true;
        }
    }
    return false;
}
function estimateTextAndImageChars(content) {
    let chars = 0;
    for (const block of content) {
        if (block.type === "text") {
            chars += block.text.length;
        }
        if (block.type === "image") {
            chars += IMAGE_CHAR_ESTIMATE;
        }
    }
    return chars;
}
function estimateMessageChars(message) {
    if (message.role === "user") {
        const content = message.content;
        if (typeof content === "string") {
            return content.length;
        }
        return estimateTextAndImageChars(content);
    }
    if (message.role === "assistant") {
        let chars = 0;
        for (const b of message.content) {
            if (b.type === "text") {
                chars += b.text.length;
            }
            if (b.type === "thinking") {
                chars += b.thinking.length;
            }
            if (b.type === "toolCall") {
                try {
                    chars += JSON.stringify(b.arguments ?? {}).length;
                }
                catch {
                    chars += 128;
                }
            }
        }
        return chars;
    }
    if (message.role === "toolResult") {
        return estimateTextAndImageChars(message.content);
    }
    return 256;
}
function estimateContextChars(messages) {
    return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}
function findAssistantCutoffIndex(messages, keepLastAssistants) {
    // keepLastAssistants <= 0 => everything is potentially prunable.
    if (keepLastAssistants <= 0) {
        return messages.length;
    }
    let remaining = keepLastAssistants;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role !== "assistant") {
            continue;
        }
        remaining--;
        if (remaining === 0) {
            return i;
        }
    }
    // Not enough assistant messages to establish a protected tail.
    return null;
}
function findFirstUserIndex(messages) {
    for (let i = 0; i < messages.length; i++) {
        if (messages[i]?.role === "user") {
            return i;
        }
    }
    return null;
}
function softTrimToolResultMessage(params) {
    const { msg, settings } = params;
    // Ignore image tool results for now: these are often directly relevant and hard to partially prune safely.
    if (hasImageBlocks(msg.content)) {
        return null;
    }
    const parts = collectTextSegments(msg.content);
    const rawLen = estimateJoinedTextLength(parts);
    if (rawLen <= settings.softTrim.maxChars) {
        return null;
    }
    const headChars = Math.max(0, settings.softTrim.headChars);
    const tailChars = Math.max(0, settings.softTrim.tailChars);
    if (headChars + tailChars >= rawLen) {
        return null;
    }
    const head = takeHeadFromJoinedText(parts, headChars);
    const tail = takeTailFromJoinedText(parts, tailChars);
    const trimmed = `${head}
...
${tail}`;
    const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;
    return { ...msg, content: [asText(trimmed + note)] };
}
export function pruneContextMessages(params) {
    const { messages, settings, ctx } = params;
    const contextWindowTokens = typeof params.contextWindowTokensOverride === "number" &&
        Number.isFinite(params.contextWindowTokensOverride) &&
        params.contextWindowTokensOverride > 0
        ? params.contextWindowTokensOverride
        : ctx.model?.contextWindow;
    if (!contextWindowTokens || contextWindowTokens <= 0) {
        return messages;
    }
    const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
    if (charWindow <= 0) {
        return messages;
    }
    const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
    if (cutoffIndex === null) {
        return messages;
    }
    // Bootstrap safety: never prune anything before the first user message. This protects initial
    // "identity" reads (SOUL.md, USER.md, etc.) which typically happen before the first inbound user
    // message exists in the session transcript.
    const firstUserIndex = findFirstUserIndex(messages);
    const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;
    const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);
    const totalCharsBefore = estimateContextChars(messages);
    let totalChars = totalCharsBefore;
    let ratio = totalChars / charWindow;
    if (ratio < settings.softTrimRatio) {
        return messages;
    }
    const prunableToolIndexes = [];
    let next = null;
    for (let i = pruneStartIndex; i < cutoffIndex; i++) {
        const msg = messages[i];
        if (!msg || msg.role !== "toolResult") {
            continue;
        }
        if (!isToolPrunable(msg.toolName)) {
            continue;
        }
        if (hasImageBlocks(msg.content)) {
            continue;
        }
        prunableToolIndexes.push(i);
        const updated = softTrimToolResultMessage({
            msg: msg,
            settings,
        });
        if (!updated) {
            continue;
        }
        const beforeChars = estimateMessageChars(msg);
        const afterChars = estimateMessageChars(updated);
        totalChars += afterChars - beforeChars;
        if (!next) {
            next = messages.slice();
        }
        next[i] = updated;
    }
    const outputAfterSoftTrim = next ?? messages;
    ratio = totalChars / charWindow;
    if (ratio < settings.hardClearRatio) {
        return outputAfterSoftTrim;
    }
    if (!settings.hardClear.enabled) {
        return outputAfterSoftTrim;
    }
    let prunableToolChars = 0;
    for (const i of prunableToolIndexes) {
        const msg = outputAfterSoftTrim[i];
        if (!msg || msg.role !== "toolResult") {
            continue;
        }
        prunableToolChars += estimateMessageChars(msg);
    }
    if (prunableToolChars < settings.minPrunableToolChars) {
        return outputAfterSoftTrim;
    }
    for (const i of prunableToolIndexes) {
        if (ratio < settings.hardClearRatio) {
            break;
        }
        const msg = (next ?? messages)[i];
        if (!msg || msg.role !== "toolResult") {
            continue;
        }
        const beforeChars = estimateMessageChars(msg);
        const cleared = {
            ...msg,
            content: [asText(settings.hardClear.placeholder)],
        };
        if (!next) {
            next = messages.slice();
        }
        next[i] = cleared;
        const afterChars = estimateMessageChars(cleared);
        totalChars += afterChars - beforeChars;
        ratio = totalChars / charWindow;
    }
    return next ?? messages;
}
