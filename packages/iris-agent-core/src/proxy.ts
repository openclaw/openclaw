/**
 * Proxy stream function — identical to pi-agent-core's proxy.
 * Routes LLM calls through a server that manages auth.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
} from "@mariozechner/pi-ai";
import { EventStream } from "@mariozechner/pi-ai";
import { parse as partialParse } from "partial-json";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProxyAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
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

export interface ProxyStreamOptions extends SimpleStreamOptions {
  authToken: string;
  proxyUrl: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function parseStreamingJson(partialJson: string): Record<string, unknown> {
  if (!partialJson || partialJson.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(partialJson) as Record<string, unknown>;
  } catch {
    try {
      const result = partialParse(partialJson);
      return (result ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

type PartialToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  partialJson: string;
};

type PartialContent = AssistantMessage["content"][number] | PartialToolCall;

function processProxyEvent(
  proxyEvent: ProxyAssistantMessageEvent,
  partial: AssistantMessage & { content: PartialContent[] },
): AssistantMessageEvent | undefined {
  switch (proxyEvent.type) {
    case "start":
      return { type: "start", partial: partial as unknown as AssistantMessage };
    case "text_start":
      partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
      return {
        type: "text_start",
        contentIndex: proxyEvent.contentIndex,
        partial: partial as unknown as AssistantMessage,
      };
    case "text_delta": {
      const c = partial.content[proxyEvent.contentIndex];
      if (c?.type === "text") {
        c.text += proxyEvent.delta;
        return {
          type: "text_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial: partial as unknown as AssistantMessage,
        };
      }
      throw new Error("Received text_delta for non-text content");
    }
    case "text_end": {
      const c = partial.content[proxyEvent.contentIndex];
      if (c?.type === "text") {
        return {
          type: "text_end",
          contentIndex: proxyEvent.contentIndex,
          content: c.text,
          partial: partial as unknown as AssistantMessage,
        };
      }
      throw new Error("Received text_end for non-text content");
    }
    case "thinking_start":
      partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
      return {
        type: "thinking_start",
        contentIndex: proxyEvent.contentIndex,
        partial: partial as unknown as AssistantMessage,
      };
    case "thinking_delta": {
      const c = partial.content[proxyEvent.contentIndex];
      if (c?.type === "thinking") {
        c.thinking += proxyEvent.delta;
        return {
          type: "thinking_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial: partial as unknown as AssistantMessage,
        };
      }
      throw new Error("Received thinking_delta for non-thinking content");
    }
    case "thinking_end": {
      const c = partial.content[proxyEvent.contentIndex];
      if (c?.type === "thinking") {
        return {
          type: "thinking_end",
          contentIndex: proxyEvent.contentIndex,
          content: c.thinking,
          partial: partial as unknown as AssistantMessage,
        };
      }
      throw new Error("Received thinking_end for non-thinking content");
    }
    case "toolcall_start":
      partial.content[proxyEvent.contentIndex] = {
        type: "toolCall",
        id: proxyEvent.id,
        name: proxyEvent.toolName,
        arguments: {},
        partialJson: "",
      };
      return {
        type: "toolcall_start",
        contentIndex: proxyEvent.contentIndex,
        partial: partial as unknown as AssistantMessage,
      };
    case "toolcall_delta": {
      const c = partial.content[proxyEvent.contentIndex] as PartialToolCall | undefined;
      if (c?.type === "toolCall") {
        c.partialJson += proxyEvent.delta;
        c.arguments = parseStreamingJson(c.partialJson);
        partial.content[proxyEvent.contentIndex] = { ...c };
        return {
          type: "toolcall_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial: partial as unknown as AssistantMessage,
        };
      }
      throw new Error("Received toolcall_delta for non-toolCall content");
    }
    case "toolcall_end": {
      const c = partial.content[proxyEvent.contentIndex] as PartialToolCall | undefined;
      if (c?.type === "toolCall") {
        const { partialJson: _p, ...toolCall } = c;
        partial.content[proxyEvent.contentIndex] = toolCall as AssistantMessage["content"][number];
        return {
          type: "toolcall_end",
          contentIndex: proxyEvent.contentIndex,
          toolCall: toolCall as Parameters<typeof Object.assign>[0],
          partial: partial as unknown as AssistantMessage,
        };
      }
      return undefined;
    }
    case "done":
      partial.stopReason = proxyEvent.reason;
      partial.usage = proxyEvent.usage;
      return {
        type: "done",
        reason: proxyEvent.reason,
        message: partial as unknown as AssistantMessage,
      };
    case "error":
      partial.stopReason = proxyEvent.reason;
      partial.errorMessage = proxyEvent.errorMessage;
      partial.usage = proxyEvent.usage;
      return {
        type: "error",
        reason: proxyEvent.reason,
        error: partial as unknown as AssistantMessage,
      };
    default: {
      console.warn(`Unhandled proxy event type: ${String((proxyEvent as { type: string }).type)}`);
      return undefined;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function streamProxy(
  model: Model<string>,
  context: Context,
  options: ProxyStreamOptions,
): EventStream<AssistantMessageEvent, AssistantMessage> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
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

  void (async () => {
    const partial: AssistantMessage & { content: PartialContent[] } = {
      role: "assistant",
      stopReason: "stop",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abortHandler = () => {
      void reader?.cancel("Request aborted by user").catch(() => {});
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
          model,
          context,
          options: {
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            reasoning: options.reasoning,
          },
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
          // ignore parse error
        }
        throw new Error(errorMessage);
      }

      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data) {
              const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
              const event = processProxyEvent(proxyEvent, partial);
              if (event) {
                stream.push(event);
              }
            }
          }
        }
      }

      if (options.signal?.aborted) {
        throw new Error("Request aborted by user");
      }
      stream.end();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const reason = options.signal?.aborted ? "aborted" : "error";
      partial.stopReason = reason;
      partial.errorMessage = errorMessage;
      stream.push({ type: "error", reason, error: partial as unknown as AssistantMessage });
      stream.end();
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  })();

  return stream;
}
