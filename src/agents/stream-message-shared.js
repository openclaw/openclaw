export function buildZeroUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
export function buildUsageWithNoCost(params) {
    const input = params.input ?? 0;
    const output = params.output ?? 0;
    const cacheRead = params.cacheRead ?? 0;
    const cacheWrite = params.cacheWrite ?? 0;
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: params.totalTokens ?? input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
export function buildAssistantMessage(params) {
    return {
        role: "assistant",
        content: params.content,
        stopReason: params.stopReason,
        api: params.model.api,
        provider: params.model.provider,
        model: params.model.id,
        usage: params.usage,
        timestamp: params.timestamp ?? Date.now(),
    };
}
export function buildAssistantMessageWithZeroUsage(params) {
    return buildAssistantMessage({
        model: params.model,
        content: params.content,
        stopReason: params.stopReason,
        usage: buildZeroUsage(),
        timestamp: params.timestamp,
    });
}
export function buildStreamErrorAssistantMessage(params) {
    return {
        ...buildAssistantMessageWithZeroUsage({
            model: params.model,
            content: [],
            stopReason: "error",
            timestamp: params.timestamp,
        }),
        stopReason: "error",
        errorMessage: params.errorMessage,
    };
}
