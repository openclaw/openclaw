import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, type Context, type Model } from "@earendil-works/pi-ai";
import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { FunctionTool, ResponseCreateParamsStreaming, ResponseInput, ResponseReasoningItem } from "openai/resources/responses/responses.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import { formatModelTransportDebugBaseUrl } from "./model-transport-url.js";
import { type OpenAIApiReasoningEffort, type OpenAIReasoningEffort } from "./openai-reasoning-effort.js";
declare const OPENAI_RESPONSES_REASONING_REPLAY_META_KEY = "__openclaw_replay";
type OpenAIResponsesReasoningReplayMetadata = {
    v: 1;
    source: "openai-responses";
    provider: string;
    api: Api;
    model: string;
    baseUrlHash?: string;
    sessionHash?: string;
    authProfileHash?: string;
};
type ReplayableResponseReasoningItem = Omit<ResponseReasoningItem, "id"> & {
    id?: string;
    [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]?: OpenAIResponsesReasoningReplayMetadata;
};
type BaseStreamOptions = {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    apiKey?: string;
    cacheRetention?: "none" | "short" | "long";
    sessionId?: string;
    authProfileId?: string;
    onPayload?: (payload: unknown, model: Model<Api>) => unknown;
    headers?: Record<string, string>;
    openclawCodeModeToolSurface?: boolean;
    responseFormat?: Record<string, unknown>;
};
type OpenAIResponsesOptions = BaseStreamOptions & {
    reasoning?: OpenAIReasoningEffort;
    reasoningEffort?: OpenAIReasoningEffort;
    reasoningSummary?: "auto" | "detailed" | "concise" | null;
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
    toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
};
type OpenAIResponsesReplayContext = {
    provider: string;
    api: Api;
    model: string;
    baseUrlHash?: string;
    sessionHash?: string;
    authProfileHash?: string;
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
        reasoningTokens?: number;
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
    errorCode?: string;
    errorType?: string;
    errorBody?: string;
};
export { sanitizeTransportPayloadText } from "./transport-stream-shared.js";
declare function summarizeResponsesTools(tools: unknown): string;
declare function enforceCodeModeResponsesToolSurface(payload: unknown): void;
declare function assertCodeModeResponsesToolSurface(payload: unknown): void;
type ResponsesFailedNoDetailsObservation = {
    event: "openai_responses_response_failed_without_details";
    provider: string;
    api: Api;
    transportModel: string;
    providerRuntimeFailureKind: "no_error_details";
    responseId: string;
    responseStatus: string;
    responseModel: string;
    responseObject: string;
    metadataKeys: string[];
    requestIdHashes: string[];
    failureFieldsPreview: string;
    responsePreview: string;
};
type ResponsesFailedEventSummary = {
    message: string;
    responseId?: string;
    observation?: ResponsesFailedNoDetailsObservation;
};
declare function buildResponsesFailedNoDetailsObservation(event: Record<string, unknown>, model: Model<Api>, response?: Record<string, unknown> | undefined): ResponsesFailedNoDetailsObservation;
declare function summarizeResponsesFailedNoDetailsObservation(observation: ResponsesFailedNoDetailsObservation): string;
declare function normalizeResponsesFailedEvent(event: Record<string, unknown>, model: Model<Api>): ResponsesFailedEventSummary;
declare function summarizeResponsesPayload(params: unknown): string;
declare function stripResponsesRequestEncryptedContent(params: OpenAIResponsesRequestParams): OpenAIResponsesRequestParams;
declare function buildOpenAIResponsesReasoningReplayMetadata(model: Model<Api>, options?: Pick<BaseStreamOptions, "authProfileId" | "sessionId">): OpenAIResponsesReasoningReplayMetadata;
declare function tagOpenAIResponsesReasoningReplayItem(item: Record<string, unknown>, model: Model<Api>, options?: Pick<BaseStreamOptions, "authProfileId" | "sessionId">): Record<string, unknown>;
declare function prepareOpenAIResponsesReasoningItemForReplay(item: ReplayableResponseReasoningItem, context: OpenAIResponsesReplayContext, blockMetadata?: OpenAIResponsesReasoningReplayMetadata): ReplayableResponseReasoningItem;
export declare function resolveAzureOpenAIApiVersion(env?: NodeJS.ProcessEnv): string;
declare function withResponsesFirstEventTimeout(openaiStream: AsyncIterable<unknown>, model: Model<Api>, timeoutMs: number | undefined): AsyncIterable<unknown>;
declare function processResponsesStream(openaiStream: AsyncIterable<unknown>, output: MutableAssistantOutput, stream: {
    push(event: unknown): void;
}, model: Model<Api>, options?: {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
    applyServiceTierPricing?: (usage: MutableAssistantOutput["usage"], serviceTier?: ResponseCreateParamsStreaming["service_tier"]) => void;
    firstEventTimeoutMs?: number;
    signal?: AbortSignal;
    sessionId?: string;
    authProfileId?: string;
}): Promise<void>;
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
}, options?: {
    signal?: AbortSignal;
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
    top_p?: number;
    text?: ResponseCreateParamsStreaming["text"];
    service_tier?: ResponseCreateParamsStreaming["service_tier"];
    tools?: FunctionTool[];
    tool_choice?: ResponseCreateParamsStreaming["tool_choice"];
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
    reasoningTokens?: number | undefined;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
};
export declare const testing: {
    assertCodeModeResponsesToolSurface: typeof assertCodeModeResponsesToolSurface;
    buildOpenAIClientHeaders: typeof buildOpenAIClientHeaders;
    buildOpenAISdkClientOptions: typeof buildOpenAISdkClientOptions;
    buildOpenAISdkRequestOptions: typeof buildOpenAISdkRequestOptions;
    createAzureOpenAIClient: typeof createAzureOpenAIClient;
    createOpenAICompletionsClient: typeof createOpenAICompletionsClient;
    createOpenAIResponsesClient: typeof createOpenAIResponsesClient;
    enforceCodeModeResponsesToolSurface: typeof enforceCodeModeResponsesToolSurface;
    sanitizeOpenAICodexResponsesParams: typeof sanitizeOpenAICodexResponsesParams;
    buildOpenAICompletionsClientConfig: typeof buildOpenAICompletionsClientConfig;
    processOpenAICompletionsStream: typeof processOpenAICompletionsStream;
    processResponsesStream: typeof processResponsesStream;
    formatModelTransportDebugBaseUrl: typeof formatModelTransportDebugBaseUrl;
    buildResponsesFailedNoDetailsObservation: typeof buildResponsesFailedNoDetailsObservation;
    buildOpenAIResponsesReasoningReplayMetadata: typeof buildOpenAIResponsesReasoningReplayMetadata;
    normalizeResponsesFailedEvent: typeof normalizeResponsesFailedEvent;
    prepareOpenAIResponsesReasoningItemForReplay: typeof prepareOpenAIResponsesReasoningItemForReplay;
    stripResponsesRequestEncryptedContent: typeof stripResponsesRequestEncryptedContent;
    tagOpenAIResponsesReasoningReplayItem: typeof tagOpenAIResponsesReasoningReplayItem;
    summarizeResponsesFailedNoDetailsObservation: typeof summarizeResponsesFailedNoDetailsObservation;
    summarizeResponsesPayload: typeof summarizeResponsesPayload;
    summarizeResponsesTools: typeof summarizeResponsesTools;
    withResponsesFirstEventTimeout: typeof withResponsesFirstEventTimeout;
};
export { testing as __testing };
