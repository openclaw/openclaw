import type { Context, Message } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { FunctionToolDefinition, InputItem, ResponseObject } from "./openai-ws-connection.js";
type ReplayModelInfo = {
    input?: ReadonlyArray<string>;
    api?: string;
};
type PlannedTurnInput = {
    inputItems: InputItem[];
    previousResponseId?: string;
    mode: "incremental_tool_results" | "full_context_initial" | "full_context_restart";
};
export declare function convertTools(tools: Context["tools"], options?: {
    strict?: boolean | null;
}): FunctionToolDefinition[];
export declare function planTurnInput(params: {
    context: Context;
    model: ReplayModelInfo;
    previousResponseId: string | null;
    lastContextLength: number;
}): PlannedTurnInput;
export declare function convertMessagesToInputItems(messages: Message[], modelOverride?: ReplayModelInfo): InputItem[];
export declare function buildAssistantMessageFromResponse(response: ResponseObject, modelInfo: {
    api: string;
    provider: string;
    id: string;
}): AssistantMessage;
export declare function convertResponseToInputItems(response: ResponseObject, modelInfo: {
    api: string;
    provider: string;
    id: string;
    input?: ReadonlyArray<string>;
}): InputItem[];
export {};
