import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";
export function isEmptyAssistantMessageContent(message) {
    const content = message.content;
    if (content == null) {
        return true;
    }
    if (!Array.isArray(content)) {
        return false;
    }
    return content.every((block) => {
        if (!block || typeof block !== "object") {
            return true;
        }
        const rec = block;
        if (rec.type !== "text") {
            return false;
        }
        return typeof rec.text !== "string" || rec.text.trim().length === 0;
    });
}
export async function sanitizeSessionMessagesImages(messages, label, options) {
    const sanitizeMode = options?.sanitizeMode ?? "full";
    const allowNonImageSanitization = sanitizeMode === "full";
    const imageSanitization = {
        maxDimensionPx: options?.maxDimensionPx,
        maxBytes: options?.maxBytes,
    };
    const shouldSanitizeToolCallIds = options?.sanitizeToolCallIds === true;
    // We sanitize historical session messages because Anthropic can reject a request
    // if the transcript contains oversized base64 images (default max side 1200px).
    const sanitizedIds = shouldSanitizeToolCallIds
        ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode)
        : messages;
    const out = [];
    for (const msg of sanitizedIds) {
        if (!msg || typeof msg !== "object") {
            out.push(msg);
            continue;
        }
        const role = msg.role;
        if (role === "toolResult") {
            const toolMsg = msg;
            const content = Array.isArray(toolMsg.content) ? toolMsg.content : [];
            const nextContent = (await sanitizeContentBlocksImages(content, label, imageSanitization));
            out.push({ ...toolMsg, content: nextContent });
            continue;
        }
        if (role === "user") {
            const userMsg = msg;
            const content = userMsg.content;
            if (Array.isArray(content)) {
                const nextContent = (await sanitizeContentBlocksImages(content, label, imageSanitization));
                out.push({ ...userMsg, content: nextContent });
                continue;
            }
        }
        if (role === "assistant") {
            const assistantMsg = msg;
            if (assistantMsg.stopReason === "error") {
                const content = assistantMsg.content;
                if (Array.isArray(content)) {
                    const nextContent = (await sanitizeContentBlocksImages(content, label, imageSanitization));
                    out.push({ ...assistantMsg, content: nextContent });
                }
                else {
                    out.push(assistantMsg);
                }
                continue;
            }
            const content = assistantMsg.content;
            if (Array.isArray(content)) {
                if (!allowNonImageSanitization) {
                    const nextContent = (await sanitizeContentBlocksImages(content, label, imageSanitization));
                    out.push({ ...assistantMsg, content: nextContent });
                    continue;
                }
                const strippedContent = options?.preserveSignatures
                    ? content // Keep signatures for Antigravity Claude
                    : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures); // Strip for Gemini
                const filteredContent = strippedContent.filter((block) => {
                    if (!block || typeof block !== "object") {
                        return true;
                    }
                    const rec = block;
                    if (rec.type !== "text" || typeof rec.text !== "string") {
                        return true;
                    }
                    return rec.text.trim().length > 0;
                });
                const finalContent = (await sanitizeContentBlocksImages(filteredContent, label, imageSanitization));
                if (finalContent.length === 0) {
                    continue;
                }
                out.push({ ...assistantMsg, content: finalContent });
                continue;
            }
        }
        out.push(msg);
    }
    return out;
}
