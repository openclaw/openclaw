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
import WebSocket from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Event Types (Server → Client)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  model: string;
  output: OutputItem[];
  usage?: UsageInfo;
  error?: { code: string; message: string };
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export type OutputItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      content: Array<{ type: "output_text"; text: string }>;
      status?: "in_progress" | "completed";
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status?: "in_progress" | "completed";
    }
  | {
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
  part: { type: "output_text"; text: string };
}

export interface ContentPartDoneEvent {
  type: "response.content_part.done";
  item_id: string;
  output_index: number;
  content_index: number;
  part: { type: "output_text"; text: string };
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

export type OpenAIWebSocketEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | RateLimitUpdatedEvent
  | ErrorEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Client → Server Event Types
// ─────────────────────────────────────────────────────────────────────────────

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | {
      type: "input_image";
      source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string };
    };

export type InputItem =
  | {
      type: "message";
      role: "system" | "developer" | "user" | "assistant";
      content: string | ContentPart[];
    }
  | { type: "function_call"; id?: string; call_id?: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; content?: string; encrypted_content?: string; summary?: string }
  | { type: "item_reference"; id: string };

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
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
  reasoning?: { effort?: "low" | "medium" | "high"; summary?: "auto" | "concise" | "detailed" };
  truncation?: "auto" | "disabled";
  [key: string]: unknown;
}

/** Warm-up payload: generate: false pre-loads connection without generating output */
export interface WarmUpEvent extends ResponseCreateEvent {
  generate: false;
}

export type ClientEvent = ResponseCreateEvent | WarmUpEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Connection Manager
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_WS_URL = "wss://api.openai.com/v1/responses";
const MAX_RETRIES = 5;
/** Backoff delays in ms: 1s, 2s, 4s, 8s, 16s */
const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

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
export class OpenAIWebSocketManager extends EventEmitter<InternalEvents> {
  private ws: WebSocket | null = null;
  private apiKey: string | null = null;
  private retryCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;

  /** The ID of the most recent completed response on this connection. */
  private _previousResponseId: string | null = null;

  private readonly wsUrl: string;
  private readonly maxRetries: number;
  private readonly backoffDelaysMs: readonly number[];

  constructor(options: OpenAIWebSocketManagerOptions = {}) {
    super();
    this.wsUrl = options.url ?? OPENAI_WS_URL;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.backoffDelaysMs = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns the previous_response_id from the last completed response,
   * for use in subsequent response.create events.
   */
  get previousResponseId(): string | null {
    return this._previousResponseId;
  }

  /**
   * Opens a WebSocket connection to the OpenAI Responses API.
   * Resolves when the connection is established (open event fires).
   * Rejects if the initial connection fails after max retries.
   */
  connect(apiKey: string): Promise<void> {
    this.apiKey = apiKey;
    this.closed = false;
    this.retryCount = 0;
    return this._openConnection();
  }

  /**
   * Sends a typed event to the OpenAI Responses API over the WebSocket.
   * Throws if the connection is not open.
   */
  send(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `OpenAIWebSocketManager: cannot send — connection is not open (readyState=${this.ws?.readyState ?? "no socket"})`,
      );
    }
    this.ws.send(JSON.stringify(event));
  }

  /**
   * Registers a handler for incoming server-sent WebSocket events.
   * Returns an unsubscribe function.
   */
  onMessage(handler: (event: OpenAIWebSocketEvent) => void): () => void {
    this.on("message", handler);
    return () => {
      this.off("message", handler);
    };
  }

  /**
   * Returns true if the WebSocket is currently open and ready to send.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Permanently closes the WebSocket connection and disables auto-reconnect.
   */
  close(): void {
    this.closed = true;
    this._cancelRetryTimer();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "Client closed");
      }
      this.ws = null;
    }
  }

  // ─── Internal: Connection Lifecycle ────────────────────────────────────────

  private _openConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.apiKey) {
        reject(new Error("OpenAIWebSocketManager: apiKey is required before connecting."));
        return;
      }

      const socket = new WebSocket(this.wsUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "responses-websocket=v1",
        },
      });

      this.ws = socket;

      const onOpen = () => {
        this.retryCount = 0;
        resolve();
        this.emit("open");
      };

      const onError = (err: Error) => {
        // Remove open listener so we don't resolve after an error.
        socket.off("open", onOpen);
        // Emit "error" on the manager only when there are listeners; otherwise
        // the promise rejection below is the primary error channel for this
        // initial connection failure. (An uncaught "error" event in Node.js
        // throws synchronously and would prevent the promise from rejecting.)
        if (this.listenerCount("error") > 0) {
          this.emit("error", err);
        }
        reject(err);
      };

      const onClose = (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        this.emit("close", code, reasonStr);

        if (!this.closed) {
          this._scheduleReconnect();
        }
      };

      const onMessage = (data: WebSocket.RawData) => {
        this._handleMessage(data);
      };

      socket.once("open", onOpen);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("message", onMessage);
    });
  }

  private _scheduleReconnect(): void {
    if (this.closed) {
      return;
    }
    if (this.retryCount >= this.maxRetries) {
      this._safeEmitError(
        new Error(`OpenAIWebSocketManager: max reconnect retries (${this.maxRetries}) exceeded.`),
      );
      return;
    }

    const delayMs =
      this.backoffDelaysMs[Math.min(this.retryCount, this.backoffDelaysMs.length - 1)] ?? 1000;
    this.retryCount++;

    this.retryTimer = setTimeout(() => {
      if (this.closed) {
        return;
      }
      this._openConnection().catch((err: unknown) => {
        // onError handler already emitted error event; schedule next retry.
        void err;
        this._scheduleReconnect();
      });
    }, delayMs);
  }

  /** Emit an error only if there are listeners; prevents Node.js from crashing
   *  with "unhandled 'error' event" when no one is listening. */
  private _safeEmitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  private _cancelRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private _handleMessage(data: WebSocket.RawData): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (Buffer.isBuffer(data)) {
      text = data.toString("utf8");
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else {
      // Blob or other — coerce to string
      text = String(data);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this._safeEmitError(
        new Error(`OpenAIWebSocketManager: failed to parse message: ${text.slice(0, 200)}`),
      );
      return;
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      this._safeEmitError(
        new Error(
          `OpenAIWebSocketManager: unexpected message shape (no "type" field): ${text.slice(0, 200)}`,
        ),
      );
      return;
    }

    const event = parsed as OpenAIWebSocketEvent;

    // Track previous_response_id on completion
    if (event.type === "response.completed" && event.response?.id) {
      this._previousResponseId = event.response.id;
    }

    this.emit("message", event);
  }

  /**
   * Sends a warm-up event to pre-load the connection and model without generating output.
   * Pass tools/instructions to prime the connection for the upcoming session.
   */
  warmUp(params: { model: string; tools?: FunctionToolDefinition[]; instructions?: string }): void {
    const event: WarmUpEvent = {
      type: "response.create",
      generate: false,
      model: params.model,
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.instructions ? { instructions: params.instructions } : {}),
    };
    this.send(event);
  }
}
