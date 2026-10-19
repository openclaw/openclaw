import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapLlamaServerStream } from "./stream.js";

afterEach(() => vi.useRealTimers());

const response: AssistantMessage = {
  role: "assistant",
  api: "openai-completions",
  provider: "llama-cpp",
  model: "local",
  content: [{ type: "text", text: "ok" }],
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

function capturePayloadHook(
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
  options: Record<string, unknown> = {},
) {
  let payloadHook: ((payload: unknown, model: unknown) => unknown) | undefined;
  const underlying = vi.fn((_model, _context, streamOptions) => {
    payloadHook = streamOptions?.onPayload;
    return {} as ReturnType<StreamFn>;
  }) as StreamFn;
  const wrapped = wrapLlamaServerStream({
    streamFn: underlying,
    thinkingLevel,
  } as ProviderWrapStreamFnContext);
  void wrapped({ provider: "llama-cpp" } as never, { messages: [] }, options as never);
  if (!payloadHook) {
    throw new Error("expected llama-server payload hook");
  }
  return payloadHook;
}

describe("llama-server stream payload", () => {
  it("maps thinking off to llama-server chat-template kwargs", async () => {
    const payloadHook = capturePayloadHook("off");

    await expect(
      payloadHook(
        {
          model: "model",
          chat_template_kwargs: { preserve_thinking: true, enable_thinking: true },
        },
        {},
      ),
    ).resolves.toEqual({
      model: "model",
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
    });
  });

  it("does not force thinking on when OpenClaw selected another level", async () => {
    const payloadHook = capturePayloadHook("high");
    const payload = { model: "model" };

    await expect(payloadHook(payload, {})).resolves.toBe(payload);
  });

  it("maps OpenAI nested JSON Schema to llama-server's direct schema field", async () => {
    const payloadHook = capturePayloadHook("off");
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };

    await expect(
      payloadHook(
        {
          model: "model",
          response_format: {
            type: "json_schema",
            json_schema: { name: "openclaw_response", schema },
          },
        },
        {},
      ),
    ).resolves.toMatchObject({
      response_format: { type: "json_object", schema },
    });
  });

  it("injects a direct schema when the shared transport omits it", async () => {
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    const payloadHook = capturePayloadHook("off", { responseFormat: schema });

    await expect(payloadHook({ model: "model" }, {})).resolves.toMatchObject({
      response_format: { type: "json_object", schema },
    });
  });
});

describe("llama-server held request status", () => {
  it("reports a response wait without claiming a slot and clears on first event", async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const source = createAssistantMessageEventStream();
    const wrapped = wrapLlamaServerStream({
      provider: "llama-cpp",
      modelId: "local",
      streamFn: async (model, _context, options) => {
        await options?.onPayload?.({}, model);
        return Object.freeze({
          [Symbol.asyncIterator]: () => source[Symbol.asyncIterator](),
          result: () => source.result(),
        });
      },
    });
    const stream = await wrapped(
      { provider: "llama-cpp" } as never,
      { messages: [] },
      {
        onProviderWait: notify,
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify.mock.calls).toEqual([["response"]]);
    const next = stream[Symbol.asyncIterator]().next();
    source.push({ type: "start", partial: response });
    await next;
    expect(notify.mock.calls).toEqual([["response"], [null]]);
    source.push({ type: "done", reason: "stop", message: response });
    expect(await stream.result()).toBe(response);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "failure"] as const)("clears a held request on %s", async (ending) => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const controller = new AbortController();
    const pending = Promise.withResolvers<ReturnType<typeof createAssistantMessageEventStream>>();
    const wrapped = wrapLlamaServerStream({
      provider: "llama-cpp",
      modelId: "local",
      streamFn: async (model, _context, options) => {
        await options?.onPayload?.({}, model);
        return pending.promise;
      },
    });
    const result = Promise.resolve(
      wrapped(
        { provider: "llama-cpp" } as never,
        { messages: [] },
        {
          onProviderWait: notify,
          signal: controller.signal,
        },
      ),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify.mock.calls).toEqual([["response"]]);
    if (ending === "cancel") {
      controller.abort();
      expect(notify.mock.calls).toEqual([["response"], [null]]);
    }
    pending.reject(new Error("request stopped"));
    expect(await result).toEqual(new Error("request stopped"));
    expect(notify.mock.calls).toEqual([["response"], [null]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a delayed wait after a synchronous transport failure", async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const wrapped = wrapLlamaServerStream({
      provider: "llama-cpp",
      modelId: "local",
      streamFn: (model, _context, options) => {
        void options?.onPayload?.({}, model);
        throw new Error("request stopped");
      },
    });
    expect(() =>
      wrapped({ provider: "llama-cpp" } as never, { messages: [] }, { onProviderWait: notify }),
    ).toThrow("request stopped");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
