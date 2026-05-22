import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { FunctionToolDefinition, InputItem, ResponseCreateEvent, WarmUpEvent } from "./openai-ws-types.js";
type WsModel = Parameters<StreamFn>[0];
type WsContext = Parameters<StreamFn>[1];
type WsOptions = Parameters<StreamFn>[2] & {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    toolChoice?: unknown;
    textVerbosity?: string;
    text_verbosity?: string;
    reasoning?: string;
    reasoningEffort?: string;
    reasoningSummary?: string;
};
interface PlannedWsTurnInput {
    inputItems: InputItem[];
    previousResponseId?: string;
}
type PlannedWsRequestPayload = {
    mode: "full_context" | "incremental";
    payload: ResponseCreateEvent;
};
export declare function planOpenAIWebSocketRequestPayload(params: {
    fullPayload: ResponseCreateEvent;
    previousRequestPayload?: ResponseCreateEvent;
    previousResponseId?: string | null;
    previousResponseInputItems?: InputItem[];
}): PlannedWsRequestPayload;
export declare function buildOpenAIWebSocketWarmUpPayload(params: {
    model: string;
    tools?: FunctionToolDefinition[];
    instructions?: string;
    metadata?: Record<string, string>;
}): WarmUpEvent;
export declare function buildOpenAIWebSocketResponseCreatePayload(params: {
    model: WsModel;
    context: WsContext;
    options?: WsOptions;
    turnInput: PlannedWsTurnInput;
    tools: FunctionToolDefinition[];
    metadata?: Record<string, string>;
}): ResponseCreateEvent;
export {};
