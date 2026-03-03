function validateTurnsWithConsecutiveMerge(params) {
    const { messages, role, merge } = params;
    if (!Array.isArray(messages) || messages.length === 0) {
        return messages;
    }
    const result = [];
    let lastRole;
    for (const msg of messages) {
        if (!msg || typeof msg !== "object") {
            result.push(msg);
            continue;
        }
        const msgRole = msg.role;
        if (!msgRole) {
            result.push(msg);
            continue;
        }
        if (msgRole === lastRole && lastRole === role) {
            const lastMsg = result[result.length - 1];
            const currentMsg = msg;
            if (lastMsg && typeof lastMsg === "object") {
                const lastTyped = lastMsg;
                result[result.length - 1] = merge(lastTyped, currentMsg);
                continue;
            }
        }
        result.push(msg);
        lastRole = msgRole;
    }
    return result;
}
function mergeConsecutiveAssistantTurns(previous, current) {
    const mergedContent = [
        ...(Array.isArray(previous.content) ? previous.content : []),
        ...(Array.isArray(current.content) ? current.content : []),
    ];
    return {
        ...previous,
        content: mergedContent,
        ...(current.usage && { usage: current.usage }),
        ...(current.stopReason && { stopReason: current.stopReason }),
        ...(current.errorMessage && {
            errorMessage: current.errorMessage,
        }),
    };
}
/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * Merges consecutive assistant messages together.
 */
export function validateGeminiTurns(messages) {
    return validateTurnsWithConsecutiveMerge({
        messages,
        role: "assistant",
        merge: mergeConsecutiveAssistantTurns,
    });
}
export function mergeConsecutiveUserTurns(previous, current) {
    const mergedContent = [
        ...(Array.isArray(previous.content) ? previous.content : []),
        ...(Array.isArray(current.content) ? current.content : []),
    ];
    return {
        ...current,
        content: mergedContent,
        timestamp: current.timestamp ?? previous.timestamp,
    };
}
/**
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern.
 * Merges consecutive user messages together.
 */
export function validateAnthropicTurns(messages) {
    return validateTurnsWithConsecutiveMerge({
        messages,
        role: "user",
        merge: mergeConsecutiveUserTurns,
    });
}
