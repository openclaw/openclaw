import type { StreamFn } from "@mariozechner/pi-agent-core";
import { type Api, type Context, type Model } from "@mariozechner/pi-ai";
import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { FunctionTool, ResponseCreateParamsStreaming, ResponseInput } from "openai/resources/responses/responses.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import { type OpenAIApiReasoningEffort, type OpenAIReasoningEffort } from "./openai-reasoning-effort.js";
type BaseStreamOptions = {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    apiKey?: string;
    cacheRetention?: "none" | "short" | "long";
    sessionId?: string;
    onPayload?: (payload: unknown, model: Model<Api>) => unknown;
    headers?: Record<string, string>;
};
type OpenAIResponsesOptions = BaseStreamOptions & {
    reasoning?: OpenAIReasoningEffort;
    reasoningEffort?: OpenAIReasoningEffort;
    reasoningSummary?: "auto" | "detailed" | "concise" | null;
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
};
type OpenAICompletionsOptions = BaseStreamOptions & {
    toolChoice?: "auto" | "none" | "required" | {
        type: "function";
        function: {
            name: string;
        };
    };
    reasoning?: OpenAIReasoningEffort;
    reasoningEffort?: OpenAIReasoningEffort;
};
type OpenAIModeCompatInput = Omit<ModelCompatConfig, "thinkingFormat"> & {
    thinkingFormat?: string;
};
type OpenAIModeModel = Omit<Model<Api>, "compat"> & {
    compat?: OpenAIModeCompatInput | null;
};
type MutableAssistantOutput = {
    role: "assistant";
    content: Array<Record<string, unknown>>;
    api: Api;
    provider: string;
    model: string;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        };
    };
    stopReason: string;
    timestamp: number;
    responseId?: string;
    errorMessage?: string;
};
export { sanitizeTransportPayloadText } from "./transport-stream-shared.js";
export declare function resolveAzureOpenAIApiVersion(env?: NodeJS.ProcessEnv): string;
declare function buildOpenAIClientHeaders(model: Model<Api>, context: Context, optionHeaders?: Record<string, string>, turnHeaders?: Record<string, string>): Record<string, string>;
declare function buildOpenAISdkClientOptions(model: Model<Api>): {
    timeout?: number;
};
declare function buildOpenAISdkRequestOptions(model: Model<Api>, signal?: AbortSignal): {
    signal?: AbortSignal;
    timeout?: number;
} | undefined;
declare function createOpenAIResponsesClient(model: Model<Api>, context: Context, apiKey: string, optionHeaders?: Record<string, string>, turnHeaders?: Record<string, string>): OpenAI;
export declare function createOpenAIResponsesTransportStreamFn(): StreamFn;
declare function sanitizeOpenAICodexResponsesParams<T extends Record<string, unknown>>(model: Model<Api>, params: T): T;
export declare function buildOpenAIResponsesParams(model: Model<Api>, context: Context, options: OpenAIResponsesOptions | undefined, metadata?: Record<string, string>): OpenAIResponsesRequestParams;
export declare function createAzureOpenAIResponsesTransportStreamFn(): StreamFn;
declare function createAzureOpenAIClient(model: Model<Api>, context: Context, apiKey: string, optionHeaders?: Record<string, string>, turnHeaders?: Record<string, string>): AzureOpenAI;
declare function createOpenAICompletionsClient(model: Model<Api>, context: Context, apiKey: string, optionHeaders?: Record<string, string>): OpenAI;
declare function buildOpenAICompletionsClientConfig(model: Model<Api>, context: Context, optionHeaders?: Record<string, string>): {
    baseURL: string;
    defaultHeaders: Record<string, string>;
    defaultQuery?: Record<string, string>;
};
export declare function createOpenAICompletionsTransportStreamFn(): StreamFn;
declare function processOpenAICompletionsStream(responseStream: AsyncIterable<ChatCompletionChunk>, output: MutableAssistantOutput, model: Model<Api>, stream: {
    push(event: unknown): void;
}): Promise<void>;
type OpenAIResponsesRequestParams = {
    model: string;
    input: ResponseInput;
    stream: true;
    instructions?: string;
    prompt_cache_key?: string;
    prompt_cache_retention?: "24h";
    metadata?: Record<string, string>;
    store?: boolean;
    max_output_tokens?: number;
    temperature?: number;
    service_tier?: ResponseCreateParamsStreaming["service_tier"];
    tools?: FunctionTool[];
    reasoning?: {
        effort: OpenAIApiReasoningEffort;
    } | {
        effort: OpenAIApiReasoningEffort;
        summary: NonNullable<OpenAIResponsesOptions["reasoningSummary"]>;
    };
    include?: string[];
};
export declare function buildOpenAICompletionsParams(model: OpenAIModeModel, context: Context, options: OpenAICompletionsOptions | undefined): Record<string, unknown>;
export declare function parseTransportChunkUsage(rawUsage: NonNullable<ChatCompletionChunk["usage"]>, model: Model<Api>): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
};
export declare const __testing: {
    buildOpenAIClientHeaders: typeof buildOpenAIClientHeaders;
    buildOpenAISdkClientOptions: typeof buildOpenAISdkClientOptions;
    buildOpenAISdkRequestOptions: typeof buildOpenAISdkRequestOptions;
    createAzureOpenAIClient: typeof createAzureOpenAIClient;
    createOpenAICompletionsClient: typeof createOpenAICompletionsClient;
    createOpenAIResponsesClient: typeof createOpenAIResponsesClient;
    sanitizeOpenAICodexResponsesParams: typeof sanitizeOpenAICodexResponsesParams;
    buildOpenAICompletionsClientConfig: typeof buildOpenAICompletionsClientConfig;
    processOpenAICompletionsStream: typeof processOpenAICompletionsStream;
};
