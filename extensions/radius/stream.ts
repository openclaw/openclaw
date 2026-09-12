import {
  createAssistantMessageEventStream,
  createToolArgumentPreviewSchedule,
  parseStreamingJson,
  type AssistantMessage,
  type AssistantMessageEvent,
  type SimpleStreamOptions,
  type StreamFunction,
  type Usage,
} from "openclaw/plugin-sdk/llm";
import { createProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import {
  buildGuardedModelFetch,
  createEmptyTransportUsage,
  failTransportStream,
  notifyProviderHttpResponse,
  parseTerminalToolCallArguments,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type RadiusStreamOptions = SimpleStreamOptions & {
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
};

const MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  const parsed = asOptionalRecord(value);
  if (!parsed) {
    throw new Error("Invalid Radius stream event object");
  }
  return parsed;
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid Radius stream string");
  }
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid Radius usage value");
  }
  return value;
}

function usage(value: unknown): Usage {
  const raw = record(value);
  const cost = record(raw.cost);
  return {
    ...raw,
    input: number(raw.input),
    output: number(raw.output),
    cacheRead: number(raw.cacheRead),
    cacheWrite: number(raw.cacheWrite),
    totalTokens: number(raw.totalTokens),
    cost: {
      ...cost,
      input: number(cost.input),
      output: number(cost.output),
      cacheRead: number(cost.cacheRead),
      cacheWrite: number(cost.cacheWrite),
      total: number(cost.total),
    },
  };
}

function createEventConverter(partial: AssistantMessage) {
  const toolJson = new Map<
    number,
    { json: string; shouldPreview: ReturnType<typeof createToolArgumentPreviewSchedule> }
  >();
  return (raw: unknown): AssistantMessageEvent => {
    const event = record(raw);
    const type = string(event.type);
    if (type === "done" || type === "error") {
      partial.usage = usage(event.usage);
      if (event.responseId !== undefined) {
        partial.responseId = string(event.responseId);
      }
      const reason = event.reason;
      if (type === "done" && (reason === "stop" || reason === "length" || reason === "toolUse")) {
        if (toolJson.size > 0) {
          throw new Error("Radius stream ended with an unfinished tool call");
        }
        partial.stopReason = reason;
        return { type, reason, message: partial };
      }
      if (type === "error" && (reason === "error" || reason === "aborted")) {
        partial.stopReason = reason;
        partial.errorMessage =
          event.errorMessage === undefined ? "Radius request failed" : string(event.errorMessage);
        return { type, reason, error: partial };
      }
      throw new Error("Invalid Radius terminal reason");
    }
    if (type === "start") {
      return { type, partial };
    }
    const contentIndex = event.contentIndex;
    if (
      typeof contentIndex !== "number" ||
      !Number.isSafeInteger(contentIndex) ||
      contentIndex < 0
    ) {
      throw new Error("Invalid Radius content index");
    }
    if (type === "text_start" || type === "thinking_start" || type === "toolcall_start") {
      if (contentIndex !== partial.content.length) {
        throw new Error("Out-of-order Radius content block");
      }
      if (type === "text_start") {
        partial.content.push({ type: "text", text: "" });
      } else if (type === "thinking_start") {
        partial.content.push({ type: "thinking", thinking: "" });
      } else {
        partial.content.push({
          type: "toolCall",
          id: string(event.id),
          name: string(event.toolName),
          arguments: {},
        });
        toolJson.set(contentIndex, {
          json: "",
          shouldPreview: createToolArgumentPreviewSchedule(),
        });
      }
      return { type, contentIndex, partial };
    }
    const block = partial.content[contentIndex];
    switch (type) {
      case "text_delta": {
        if (block?.type !== "text") {
          break;
        }
        const delta = string(event.delta);
        block.text += delta;
        return { type, contentIndex, delta, partial };
      }
      case "text_end": {
        if (block?.type !== "text") {
          break;
        }
        block.text = string(event.content);
        if (event.contentSignature !== undefined) {
          block.textSignature = string(event.contentSignature);
        }
        return { type, contentIndex, content: block.text, partial };
      }
      case "thinking_delta": {
        if (block?.type !== "thinking") {
          break;
        }
        const delta = string(event.delta);
        block.thinking += delta;
        return { type, contentIndex, delta, partial };
      }
      case "thinking_end": {
        if (block?.type !== "thinking") {
          break;
        }
        block.thinking = string(event.content);
        if (event.contentSignature !== undefined) {
          block.thinkingSignature = string(event.contentSignature);
        }
        if (event.redacted !== undefined && typeof event.redacted !== "boolean") {
          throw new Error("Invalid Radius redacted thinking flag");
        }
        block.redacted = event.redacted;
        return { type, contentIndex, content: block.thinking, partial };
      }
      case "toolcall_delta": {
        const pending = toolJson.get(contentIndex);
        if (block?.type !== "toolCall" || !pending) {
          break;
        }
        const delta = string(event.delta);
        pending.json += delta;
        if (pending.shouldPreview(pending.json.length)) {
          block.arguments = parseStreamingJson(pending.json);
        }
        return { type, contentIndex, delta, partial };
      }
      case "toolcall_end": {
        if (block?.type !== "toolCall" || !toolJson.has(contentIndex)) {
          break;
        }
        const call = record(event.toolCall);
        if (call.type !== "toolCall" || call.id !== block.id || call.name !== block.name) {
          throw new Error("Radius terminal tool call does not match its start");
        }
        block.arguments = parseTerminalToolCallArguments(call.arguments);
        if (call.thoughtSignature !== undefined) {
          block.thoughtSignature = string(call.thoughtSignature);
        }
        toolJson.delete(contentIndex);
        return { type, contentIndex, toolCall: block, partial };
      }
    }
    throw new Error("Invalid Radius stream event or content block sequence");
  };
}

async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = /\r\n\r\n|\n\n|\r\r/u.exec(buffer);
        if (!boundary && !done) {
          break;
        }
        const frame = boundary ? buffer.slice(0, boundary.index) : buffer;
        if (Buffer.byteLength(frame, "utf8") > MAX_SSE_EVENT_BYTES) {
          throw new Error("Radius SSE event exceeds 16 MiB");
        }
        buffer = boundary ? buffer.slice(boundary.index + boundary[0].length) : "";
        const data = frame
          .split(/\r\n|\n|\r/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          yield JSON.parse(data);
        }
        if (!boundary) {
          break;
        }
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_EVENT_BYTES) {
        throw new Error("Radius SSE event exceeds 16 MiB");
      }
      if (done) {
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Radius speaks Pi's native message protocol, not an OpenAI-compatible API. */
export function createRadiusStreamFn(): StreamFunction<string, RadiusStreamOptions> {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createEmptyTransportUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const convert = createEventConverter(partial);
    void (async () => {
      let response: Response | undefined;
      try {
        if (!options?.apiKey) {
          throw new Error(
            "No Radius access token configured. Run openclaw models auth login --provider radius.",
          );
        }
        options.signal?.throwIfAborted();
        let payload: unknown = {
          model: model.id,
          context,
          options: {
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            reasoning: options.reasoning,
            cacheRetention: options.cacheRetention,
            sessionId: options.sessionId,
            toolChoice: options.toolChoice,
          },
        };
        const replacement = await options.onPayload?.(payload, model);
        if (replacement !== undefined) {
          payload = replacement;
        }
        options.signal?.throwIfAborted();
        const guardedFetch = buildGuardedModelFetch(model, options.timeoutMs, {
          sanitizeSse: false,
        });
        response = await guardedFetch(`${model.baseUrl.replace(/\/+$/u, "")}/messages`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            accept: "text/event-stream",
            "content-type": "application/json",
            ...model.headers,
            ...options.headers,
          },
          body: JSON.stringify(payload),
          signal: options.signal,
        });
        await notifyProviderHttpResponse({ options, response, model });
        if (!response.ok) {
          throw await createProviderHttpError(response, "Radius request failed");
        }
        if (!response.body) {
          throw new Error("Radius response has no body");
        }
        for await (const raw of readEvents(response.body, options.signal)) {
          const event = convert(raw);
          stream.push(event);
          if (event.type === "done" || event.type === "error") {
            stream.end();
            return;
          }
        }
        throw new Error("Radius stream ended without a terminal event");
      } catch (error) {
        failTransportStream({ stream, output: partial, signal: options?.signal, error });
      } finally {
        await response?.body?.cancel().catch(() => undefined);
      }
    })();
    return stream;
  };
}
