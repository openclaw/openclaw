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
}
export interface UsageInfo {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
}
export type OpenAIResponsesAssistantPhase = "commentary" | "final_answer";
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
    type: "reasoning";
    id: string;
    content?: string;
    summary?: string;
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
    code: string;
    message: string;
    param?: string;
}
export type OpenAIWebSocketEvent = ResponseCreatedEvent | ResponseInProgressEvent | ResponseCompletedEvent | ResponseFailedEvent | OutputItemAddedEvent | OutputItemDoneEvent | ContentPartAddedEvent | ContentPartDoneEvent | OutputTextDeltaEvent | OutputTextDoneEvent | FunctionCallArgumentsDeltaEvent | FunctionCallArgumentsDoneEvent | RateLimitUpdatedEvent | ErrorEvent;
export type ContentPart = {
    type: "input_text";
    text: string;
} | {
    type: "output_text";
    text: string;
} | {
    type: "input_image";
    source: {
        type: "url";
        url: string;
    } | {
        type: "base64";
        media_type: string;
        data: string;
    };
};
export type InputItem = {
    type: "message";
    role: "system" | "developer" | "user" | "assistant";
    content: string | ContentPart[];
    phase?: OpenAIResponsesAssistantPhase;
} | {
    type: "function_call";
    id?: string;
    call_id?: string;
    name: string;
    arguments: string;
} | {
    type: "function_call_output";
    call_id: string;
    output: string;
} | {
    type: "reasoning";
    content?: string;
    encrypted_content?: string;
    summary?: string;
} | {
    type: "item_reference";
    id: string;
};
export type ToolChoice = "auto" | "none" | "required" | {
    type: "function";
    function: {
        name: string;
    };
};
export interface FunctionToolDefinition {
    type: "function";
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
}
/** Standard response.create event payload (full turn) */
export interface ResponseCreateEvent {
    type: "response.create";
    model: string;
    store?: boolean;
    stream?: boolean;
    input?: string | InputItem[];
    instructions?: string;
    tools?: FunctionToolDefinition[];
    tool_choice?: ToolChoice;
    context_management?: unknown;
    previous_response_id?: string;
    max_output_tokens?: number;
    temperature?: number;
    top_p?: number;
    metadata?: Record<string, string>;
    reasoning?: {
        effort?: "low" | "medium" | "high";
        summary?: "auto" | "concise" | "detailed";
    };
    truncation?: "auto" | "disabled";
    [key: string]: unknown;
}
/** Warm-up payload: generate: false pre-loads connection without generating output */
export interface WarmUpEvent extends ResponseCreateEvent {
    generate: false;
}
export type ClientEvent = ResponseCreateEvent | WarmUpEvent;
export interface OpenAIWebSocketManagerOptions {
    /** Override the default WebSocket URL (useful for testing) */
    url?: string;
    /** Maximum number of reconnect attempts (default: 5) */
    maxRetries?: number;
    /** Custom backoff delays in ms (default: [1000, 2000, 4000, 8000, 16000]) */
    backoffDelaysMs?: readonly number[];
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
 * manager.send({ type: "response.create", model: "gpt-5.2", input: [...] });
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
    private readonly wsUrl;
    private readonly maxRetries;
    private readonly backoffDelaysMs;
    constructor(options?: OpenAIWebSocketManagerOptions);
    /**
     * Returns the previous_response_id from the last completed response,
     * for use in subsequent response.create events.
     */
    get previousResponseId(): string | null;
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
    }): void;
}
export {};
