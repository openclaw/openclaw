import type { AssistantMessage, StopReason, Usage } from "@mariozechner/pi-ai";
export type StreamModelDescriptor = {
    api: string;
    provider: string;
    id: string;
};
export declare function buildZeroUsage(): Usage;
export declare function buildUsageWithNoCost(params: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
}): Usage;
export declare function buildAssistantMessage(params: {
    model: StreamModelDescriptor;
    content: AssistantMessage["content"];
    stopReason: StopReason;
    usage: Usage;
    timestamp?: number;
}): AssistantMessage;
export declare function buildAssistantMessageWithZeroUsage(params: {
    model: StreamModelDescriptor;
    content: AssistantMessage["content"];
    stopReason: StopReason;
    timestamp?: number;
}): AssistantMessage;
export declare const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";
export declare function buildStreamErrorAssistantMessage(params: {
    model: StreamModelDescriptor;
    errorMessage: string;
    timestamp?: number;
}): AssistantMessage & {
    stopReason: "error";
    errorMessage: string;
};
