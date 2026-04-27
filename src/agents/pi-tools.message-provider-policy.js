import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
const TOOL_DENY_BY_MESSAGE_PROVIDER = {
    voice: ["tts"],
};
const TOOL_ALLOW_BY_MESSAGE_PROVIDER = {
    node: ["canvas", "image", "pdf", "tts", "web_fetch", "web_search"],
};
export function filterToolNamesByMessageProvider(toolNames, messageProvider) {
    const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
    if (!normalizedProvider) {
        return [...toolNames];
    }
    const allowedTools = TOOL_ALLOW_BY_MESSAGE_PROVIDER[normalizedProvider];
    if (allowedTools && allowedTools.length > 0) {
        const allowedSet = new Set(allowedTools);
        return toolNames.filter((toolName) => allowedSet.has(toolName));
    }
    const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
    if (!deniedTools || deniedTools.length === 0) {
        return [...toolNames];
    }
    const deniedSet = new Set(deniedTools);
    return toolNames.filter((toolName) => !deniedSet.has(toolName));
}
export function filterToolsByMessageProvider(tools, messageProvider) {
    const filteredToolNames = filterToolNamesByMessageProvider(tools.map((tool) => tool.name), messageProvider);
    const remainingCounts = new Map();
    for (const toolName of filteredToolNames) {
        remainingCounts.set(toolName, (remainingCounts.get(toolName) ?? 0) + 1);
    }
    return tools.filter((tool) => {
        const remaining = remainingCounts.get(tool.name) ?? 0;
        if (remaining <= 0) {
            return false;
        }
        remainingCounts.set(tool.name, remaining - 1);
        return true;
    });
}
