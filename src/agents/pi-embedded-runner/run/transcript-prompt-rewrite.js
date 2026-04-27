import { emitSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
import { rewriteTranscriptEntriesInSessionManager } from "../transcript-rewrite.js";
function extractPromptTextFromMessage(message) {
    const content = message.content;
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return undefined;
    }
    const textBlocks = content
        .map((block) => block && typeof block === "object" && typeof block.text === "string"
        ? block.text
        : undefined)
        .filter((text) => typeof text === "string");
    return textBlocks.length > 0 ? textBlocks.join("") : undefined;
}
function replacePromptTextInMessage(message, text) {
    const content = message.content;
    const entry = message;
    if (typeof content === "string") {
        return { ...entry, content: text };
    }
    if (!Array.isArray(content)) {
        return { ...entry, content: text };
    }
    let replaced = false;
    const nextContent = [];
    for (const block of content) {
        if (replaced ||
            !block ||
            typeof block !== "object" ||
            typeof block.text !== "string") {
            nextContent.push(block);
            continue;
        }
        replaced = true;
        nextContent.push({ ...block, text });
    }
    return {
        ...entry,
        content: replaced ? nextContent : text,
    };
}
export function rewriteSubmittedPromptTranscript(params) {
    const transcriptPrompt = params.transcriptPrompt;
    if (transcriptPrompt === undefined || transcriptPrompt === params.submittedPrompt) {
        return;
    }
    const replacementText = transcriptPrompt.trim() || "[OpenClaw runtime event]";
    const branch = params.sessionManager.getBranch();
    const startIndex = params.previousLeafId
        ? Math.max(0, branch.findIndex((entry) => entry.id === params.previousLeafId) + 1)
        : 0;
    const target = branch.slice(startIndex).find((entry) => {
        if (entry.type !== "message" || entry.message.role !== "user") {
            return false;
        }
        const text = extractPromptTextFromMessage(entry.message);
        return text === params.submittedPrompt;
    });
    if (!target || target.type !== "message") {
        return;
    }
    const result = rewriteTranscriptEntriesInSessionManager({
        sessionManager: params.sessionManager,
        replacements: [
            {
                entryId: target.id,
                message: replacePromptTextInMessage(target.message, replacementText),
            },
        ],
    });
    if (result.changed) {
        emitSessionTranscriptUpdate(params.sessionFile);
    }
}
