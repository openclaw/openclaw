/**
 * OpenAI WebSocket Connection Manager
 *
 * Manages a persistent WebSocket connection to the OpenAI Responses API
 * (wss://api.openai.com/v1/responses) for multi-turn tool-call workflows.
 *
 * Features:
 * - Auto-reconnect with exponential backoff (max 5 retries: 1s/2s/4s/8s/16s)
 * - Tracks previous_response_id per connection for incremental turns
 * - Warm-up support (generate: false) to pre-load the connection
 * - Typed WebSocket event definitions matching the Responses API SSE spec
 *
 * @see https://developers.openai.com/api/docs/guides/websocket-mode
 */
import { EventEmitter } from "node:events";
import WebSocket, { type ClientOptions } from "ws";
import type { ClientEvent, FunctionToolDefinition, OpenAIResponsesAssistantPhase } from "./openai-ws-types.js";
import { type ModelProviderRequestTransportOverrides } from "./provider-request-config.js";
export interface ResponseObject {
    id: string;
    object: "response";
    created_at: number;
    status: "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
    model: string;
    output: OutputItem[];
    usage?: UsageInfo;
    error?: {
        code: string;
        message: string;
    };
    incomplete_details?: {
        reason?: string;
    };
}
export interface UsageInfo {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens_details?: {
        cached_tokens?: number;
    };
}
export type OutputItem = {
    type: "message";
    id: string;
    role: "assistant";
    content: Array<{
        type: "output_text";
        text: string;
    }>;
    phase?: OpenAIResponsesAssistantPhase;
    status?: "in_progress" | "completed";
} | {
    type: "function_call";
    id: string;
    call_id: string;
    name: string;
    arguments: string;
    status?: "in_progress" | "completed";
} | {
    type: "reasoning" | `reasoning.${string}`;
    id: string;
    content?: unknown;
    encrypted_content?: string;
    summary?: unknown;
};
export interface ResponseCreatedEvent {
    type: "response.created";
    response: ResponseObject;
}
export interface ResponseInProgressEvent {
    type: "response.in_progress";
    response: ResponseObject;
}
export interface ResponseCompletedEvent {
    type: "response.completed";
    response: ResponseObject;
}
export interface ResponseFailedEvent {
    type: "response.failed";
    response: ResponseObject;
}
export interface OutputItemAddedEvent {
    type: "response.output_item.added";
    output_index: number;
    item: OutputItem;
}
export interface OutputItemDoneEvent {
    type: "response.output_item.done";
    output_index: number;
    item: OutputItem;
}
export interface ContentPartAddedEvent {
    type: "response.content_part.added";
    item_id: string;
    output_index: number;
    content_index: number;
    part: {
        type: "output_text";
        text: string;
    };
}
export interface ContentPartDoneEvent {
    type: "response.content_part.done";
    item_id: string;
    output_index: number;
    content_index: number;
    part: {
        type: "output_text";
        text: string;
    };
}
export interface OutputTextDeltaEvent {
    type: "response.output_text.delta";
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
}
export interface OutputTextDoneEvent {
    type: "response.output_text.done";
    item_id: string;
    output_index: number;
    content_index: number;
    text: string;
}
export interface FunctionCallArgumentsDeltaEvent {
    type: "response.function_call_arguments.delta";
    item_id: string;
    output_index: number;
    call_id: string;
    delta: string;
}
export interface FunctionCallArgumentsDoneEvent {
    type: "response.function_call_arguments.done";
    item_id: string;
    output_index: number;
    call_id: string;
    arguments: string;
}
export interface RateLimitUpdatedEvent {
    type: "rate_limits.updated";
    rate_limits: Array<{
        name: string;
        limit: number;
        remaining: number;
        reset_seconds: number;
    }>;
}
export interface ErrorEvent {
    type: "error";
    status?: number;
    code?: string;
    message?: string;
    param?: string;
    error?: {
        type?: string;
        code?: string;
        message?: string;
        param?: string;
    };
}
export type OpenAIWebSocketEvent = ResponseCreatedEvent | ResponseInProgressEvent | ResponseCompletedEvent | ResponseFailedEvent | OutputItemAddedEvent | OutputItemDoneEvent | ContentPartAddedEvent | ContentPartDoneEvent | OutputTextDeltaEvent | OutputTextDoneEvent | FunctionCallArgumentsDeltaEvent | FunctionCallArgumentsDoneEvent | RateLimitUpdatedEvent | ErrorEvent;
export type { ClientEvent, ContentPart, FunctionToolDefinition, InputItem, OpenAIResponsesAssistantPhase, ResponseCreateEvent, ToolChoice, WarmUpEvent, } from "./openai-ws-types.js";
export interface OpenAIWebSocketManagerOptions {
    /** Override the default WebSocket URL (useful for testing) */
    url?: string;
    /** Maximum number of reconnect attempts (default: 5) */
    maxRetries?: number;
    /** Custom backoff delays in ms (default: [1000, 2000, 4000, 8000, 16000]) */
    backoffDelaysMs?: readonly number[];
    /** Custom socket factory for tests. */
    socketFactory?: (url: string, options: ClientOptions) => WebSocket;
    /** Extra headers merged into the initial WebSocket handshake request. */
    headers?: Record<string, string>;
    /** Optional transport overrides for provider-owned auth or TLS wiring. */
    request?: ModelProviderRequestTransportOverrides;
}
export type OpenAIWebSocketConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";
export interface OpenAIWebSocketCloseInfo {
    code: number;
    reason: string;
    retryable: boolean;
}
type InternalEvents = {
    message: [event: OpenAIWebSocketEvent];
    open: [];
    close: [code: number, reason: string];
    error: [err: Error];
};
/**
 * Manages a persistent WebSocket connection to the OpenAI Responses API.
 *
 * Usage:
 * ```ts
 * const manager = new OpenAIWebSocketManager();
 * await manager.connect(apiKey);
 *
 * manager.onMessage((event) => {
 *   if (event.type === "response.completed") {
 *     console.log("Response ID:", event.response.id);
 *   }
 * });
 *
 * manager.send({ type: "response.create", model: "gpt-5.4", input: [...] });
 * ```
 */
export declare class OpenAIWebSocketManager extends EventEmitter<InternalEvents> {
    private ws;
    private apiKey;
    private retryCount;
    private retryTimer;
    private closed;
    /** The ID of the most recent completed response on this connection. */
    private _previousResponseId;
    private _connectionState;
    private _lastCloseInfo;
    private readonly wsUrl;
    private readonly maxRetries;
    private readonly backoffDelaysMs;
    private readonly socketFactory;
    private readonly headers?;
    private readonly request?;
    private readonly flowId;
    constructor(options?: OpenAIWebSocketManagerOptions);
    /**
     * Returns the previous_response_id from the last completed response,
     * for use in subsequent response.create events.
     */
    get previousResponseId(): string | null;
    get connectionState(): OpenAIWebSocketConnectionState;
    get lastCloseInfo(): OpenAIWebSocketCloseInfo | null;
    /**
     * Opens a WebSocket connection to the OpenAI Responses API.
     * Resolves when the connection is established (open event fires).
     * Rejects if the initial connection fails after max retries.
     */
    connect(apiKey: string): Promise<void>;
    /**
     * Sends a typed event to the OpenAI Responses API over the WebSocket.
     * Throws if the connection is not open.
     */
    send(event: ClientEvent): void;
    /**
     * Registers a handler for incoming server-sent WebSocket events.
     * Returns an unsubscribe function.
     */
    onMessage(handler: (event: OpenAIWebSocketEvent) => void): () => void;
    /**
     * Returns true if the WebSocket is currently open and ready to send.
     */
    isConnected(): boolean;
    /**
     * Permanently closes the WebSocket connection and disables auto-reconnect.
     */
    close(): void;
    private _openConnection;
    private _scheduleReconnect;
    /** Emit an error only if there are listeners; prevents Node.js from crashing
     *  with "unhandled 'error' event" when no one is listening. */
    private _safeEmitError;
    private _cancelRetryTimer;
    private _handleMessage;
    /**
     * Sends a warm-up event to pre-load the connection and model without generating output.
     * Pass tools/instructions to prime the connection for the upcoming session.
     */
    warmUp(params: {
        model: string;
        tools?: FunctionToolDefinition[];
        instructions?: string;
        metadata?: Record<string, string>;
    }): void;
}
export declare function getOpenAIWebSocketErrorDetails(event: ErrorEvent): {
    status?: number;
    type?: string;
    code?: string;
    message?: string;
    param?: string;
};
