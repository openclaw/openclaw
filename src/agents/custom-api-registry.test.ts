import { createApiRegistry, createLlmRuntime, type ApiRegistry } from "@openclaw/ai";
import { getEventStreamCompletion } from "@openclaw/ai/internal/runtime";
import { resetApiProviders } from "@openclaw/ai/providers";
import type { AssistantMessageEvent, StreamFn } from "@openclaw/llm-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";

let registry: ApiRegistry;
const model = { api: "test-custom-api", provider: "custom", id: "m" };

function register(streamFn: Parameters<typeof ensureCustomApiRegistered>[2]) {
  expect(ensureCustomApiRegistered(registry, model.api, streamFn)).toBe(true);
  return registry.getApiProvider(model.api)!;
}

describe("ensureCustomApiRegistered", () => {
  beforeEach(() => {
    registry = createApiRegistry();
  });

  it("registers a custom api provider once", () => {
    const streamFn = vi.fn(() => createAssistantMessageEventStream());
    register(streamFn);
    expect(ensureCustomApiRegistered(registry, model.api, streamFn)).toBe(false);
  });

  it("delegates both stream entrypoints to the provided stream function", () => {
    const stream = createAssistantMessageEventStream();
    const streamFn = vi.fn(() => stream);
    const provider = register(streamFn);
    expect(provider.stream(model as never, { messages: [] }, { maxTokens: 32 })).toBe(stream);
    expect(provider.streamSimple(model as never, { messages: [] }, { maxTokens: 32 })).toBe(stream);
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it("preserves producer completion and lazy decorated results for synchronous SDK streams", async () => {
    const original = buildAssistantMessage({
      model,
      content: [],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    });
    const repaired = { ...original, content: [{ type: "text" as const, text: "repaired" }] };
    const source = createAssistantMessageEventStream();
    const decoratedResult = vi.fn(async () => repaired);
    source.result = decoratedResult;
    register(() => source);
    const stream = createLlmRuntime(registry).stream(model as never, { messages: [] });
    const completion = getEventStreamCompletion(stream);
    expect(completion).toBe(getEventStreamCompletion(source));
    source.push({ type: "done", reason: "stop", message: original });
    await expect(completion).resolves.toBe(original);
    expect(decoratedResult).not.toHaveBeenCalled();
    await expect(stream.result()).resolves.toBe(repaired);
    expect(decoratedResult).toHaveBeenCalledTimes(1);
  });

  it("adapts async stream factories to the synchronous provider contract", async () => {
    const message = buildAssistantMessage({
      model,
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    });
    const streamFn = async () => {
      await Promise.resolve();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    const stream = register(streamFn).stream(model as never, { messages: [] }, {});

    expect(stream).not.toBeInstanceOf(Promise);
    await expect(stream.result()).resolves.toBe(message);
  });

  it.each(["sync", "async"] as const)(
    "accepts %s read-only streams through the LLM runtime",
    async (factoryKind) => {
      const message = buildAssistantMessage({
        model,
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: buildUsageWithNoCost({}),
      });
      const repaired = { ...message, content: [{ type: "text" as const, text: "repaired" }] };
      const events: AssistantMessageEvent[] = [
        { type: "text_delta", contentIndex: 0, delta: "done", partial: message },
        { type: "done", reason: "stop", message },
      ];
      const factory: StreamFn = () => {
        const stream = Object.freeze({
          result: async () => repaired,
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
        });
        return factoryKind === "async" ? Promise.resolve(stream) : stream;
      };
      register(factory);
      const runtime = createLlmRuntime(registry);
      const stream = runtime.stream(model as never, { messages: [] });
      const result = stream.result();
      const received: AssistantMessageEvent[] = [];
      for await (const event of stream) {
        received.push(event);
      }
      expect(received).toEqual(events);
      await expect(getEventStreamCompletion(stream)).resolves.toBe(message);
      await expect(result).resolves.toBe(repaired);
      await expect(stream.result()).resolves.toBe(repaired);
      await expect(runtime.completeSimple(model as never, { messages: [] })).resolves.toBe(
        repaired,
      );
    },
  );

  it("preserves read-only abort events and passes the caller's cancellation signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const message = buildAssistantMessage({
      model,
      content: [],
      stopReason: "aborted",
      usage: buildUsageWithNoCost({}),
    });
    register((_model, _context, options) => {
      expect(options?.signal).toBe(controller.signal);
      return Object.freeze({
        result: async () => message,
        async *[Symbol.asyncIterator]() {
          yield { type: "error", reason: "aborted", error: message } as const;
        },
      });
    });
    const runtime = createLlmRuntime(registry);
    const stream = runtime.stream(model as never, { messages: [] }, { signal: controller.signal });
    const received: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      received.push(event);
    }
    expect(received).toEqual([{ type: "error", reason: "aborted", error: message }]);
    await expect(stream.result()).resolves.toBe(message);
  });

  it("converts read-only iterator failures into terminal runtime errors", async () => {
    register(() => ({
      result: () => Promise.reject(new Error("result must not be called")),
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", contentIndex: 0, delta: "partial" } as const;
        throw new Error("iterator failed");
      },
    }));
    const runtime = createLlmRuntime(registry);
    await expect(runtime.completeSimple(model as never, { messages: [] })).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "iterator failed",
    });
  });

  it("reports read-only result failures even after a successful terminal event", async () => {
    const message = buildAssistantMessage({
      model,
      content: [],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    });
    register(() => ({
      result: async () => {
        throw new Error("result failed");
      },
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message } as const;
      },
    }));
    await expect(
      createLlmRuntime(registry).completeSimple(model as never, { messages: [] }),
    ).resolves.toMatchObject({ stopReason: "error", errorMessage: "result failed" });
  });

  it("converts async stream factory failures into terminal stream errors", async () => {
    const streamFn = async () => {
      throw new Error("factory failed");
    };
    const stream = register(streamFn).stream(model as never, { messages: [] }, {});

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "factory failed",
    });
  });

  it("keeps plugin api providers when refreshing built-ins", () => {
    const sourceId = "plugin:test-reset-api";
    const api = "test-reset-plugin-api";
    const streamFn = vi.fn(() => createAssistantMessageEventStream());
    registry.registerApiProvider({ api, stream: streamFn, streamSimple: streamFn }, sourceId);

    resetApiProviders(registry);

    expect(registry.getApiProvider(api)).toBeDefined();
    expect(registry.getApiProvider("openai-responses")).toBeDefined();
  });
});
