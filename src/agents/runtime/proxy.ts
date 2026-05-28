/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

import { createAssistantStreamAccumulator } from "../../llm/assistant-stream-accumulator.js";
// Internal import for JSON parsing utility
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type ToolCall,
} from "../../llm/types.js";
import { EventStream } from "../../llm/utils/event-stream.js";
import { parseStreamingJson } from "../../llm/utils/json-parse.js";

type StreamingToolCall = ToolCall & { partialJson?: string };

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        }
        if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected event type");
      },
    );
  }
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string; replace?: boolean }
  | { type: "text_end"; contentIndex: number; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; contentSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      usage: AssistantMessage["usage"];
    }
  | {
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      errorMessage?: string;
      usage: AssistantMessage["usage"];
    };

type ProxySerializableStreamOptions = Pick<
  SimpleStreamOptions,
  | "temperature"
  | "maxTokens"
  | "reasoning"
  | "cacheRetention"
  | "sessionId"
  | "promptCacheKey"
  | "metadata"
  | "transport"
  | "thinkingBudgets"
  | "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
  /** Local abort signal for the proxy request */
  signal?: AbortSignal;
  /** Auth token for the proxy server */
  authToken: string;
  /** Proxy server URL (e.g., "https://genai.example.com") */
  proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
  return {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    reasoning: options.reasoning,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    promptCacheKey: options.promptCacheKey,
    metadata: options.metadata,
    transport: options.transport,
    thinkingBudgets: options.thinkingBudgets,
    maxRetryDelayMs: options.maxRetryDelayMs,
  };
}

function sanitizeProxyModel(model: Model): Model {
  const { headers: _headers, ...safeModel } = model;
  return safeModel as Model;
}

export function streamProxy(
  model: Model,
  context: Context,
  options: ProxyStreamOptions,
): ProxyMessageEventStream {
  const stream = new ProxyMessageEventStream();

  void (async () => {
    const accumulator = createAssistantStreamAccumulator({
      model: { api: model.api, provider: model.provider, model: model.id },
      deltaPartialMode: "snapshot",
    });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const abortHandler = () => {
      if (reader) {
        reader.cancel("Request aborted by user").catch(() => {});
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler);
    }

    try {
      const response = await fetch(`${options.proxyUrl}/api/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: sanitizeProxyModel(model),
          context,
          options: buildProxyRequestOptions(options),
        }),
        signal: options.signal,
      });

      if (!response.ok) {
        let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
        try {
          const errorData = (await response.json()) as { error?: string };
          if (errorData.error) {
            errorMessage = `Proxy error: ${errorData.error}`;
          }
        } catch {
          // Couldn't parse error response
        }
        throw new Error(errorMessage);
      }

      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalEventSeen = false;

      const processSseLine = (line: string) => {
        if (!line.startsWith("data: ")) {
          return;
        }
        const data = line.slice(6).trim();
        if (!data) {
          return;
        }
        const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
        const event = processProxyEvent(proxyEvent, accumulator);
        if (!event) {
          return;
        }
        terminalEventSeen = event.type === "done" || event.type === "error";
        stream.push(event);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (options.signal?.aborted) {
          throw new Error("Request aborted by user");
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          processSseLine(line);
        }
      }

      if (options.signal?.aborted) {
        throw new Error("Request aborted by user");
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        processSseLine(buffer);
      }
      if (!terminalEventSeen) {
        throw new Error("Proxy stream ended before terminal event");
      }

      stream.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const reason = options.signal?.aborted ? "aborted" : "error";
      stream.push(accumulator.error(reason, { errorMessage }));
      stream.end();
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  })();

  return stream;
}

/**
 * Process a proxy event and update the local assistant stream accumulator.
 */
function processProxyEvent(
  proxyEvent: ProxyAssistantMessageEvent,
  accumulator: ReturnType<typeof createAssistantStreamAccumulator>,
): AssistantMessageEvent | undefined {
  switch (proxyEvent.type) {
    case "start":
      return accumulator.start();

    case "text_start":
      return accumulator.startText(proxyEvent.contentIndex);

    case "text_delta":
      return accumulator.appendTextDelta(proxyEvent.contentIndex, proxyEvent.delta, {
        replace: proxyEvent.replace === true,
      });

    case "text_end":
      return accumulator.endText(proxyEvent.contentIndex, {
        textSignature: proxyEvent.contentSignature,
      });

    case "thinking_start":
      return accumulator.startThinking(proxyEvent.contentIndex);

    case "thinking_delta":
      return accumulator.appendThinkingDelta(proxyEvent.contentIndex, proxyEvent.delta);

    case "thinking_end":
      return accumulator.endThinking(proxyEvent.contentIndex, {
        thinkingSignature: proxyEvent.contentSignature,
      });

    case "toolcall_start":
      return accumulator.startToolCall(proxyEvent.contentIndex, {
        type: "toolCall",
        id: proxyEvent.id,
        name: proxyEvent.toolName,
        arguments: {},
        partialJson: "",
      } satisfies ToolCall & { partialJson: string } as ToolCall);

    case "toolcall_delta":
      return accumulator.appendToolCallDelta(
        proxyEvent.contentIndex,
        proxyEvent.delta,
        (toolCall) => {
          const streamingContent = toolCall as StreamingToolCall;
          streamingContent.partialJson = `${streamingContent.partialJson ?? ""}${proxyEvent.delta}`;
          toolCall.arguments = parseStreamingJson(streamingContent.partialJson) || {};
        },
      );

    case "toolcall_end":
      return accumulator.endToolCall(proxyEvent.contentIndex, (toolCall) => {
        delete (toolCall as StreamingToolCall).partialJson;
      });

    case "done":
      return accumulator.done(proxyEvent.reason, { usage: proxyEvent.usage });

    case "error":
      return accumulator.error(proxyEvent.reason, {
        errorMessage: proxyEvent.errorMessage,
        usage: proxyEvent.usage,
      });

    default: {
      proxyEvent satisfies never;
      console.warn(`Unhandled proxy event type: ${(proxyEvent as { type?: string }).type}`);
      return undefined;
    }
  }
}
