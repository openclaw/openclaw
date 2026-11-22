import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { wrapLlamaServerStream } from "./stream.js";

afterEach(() => vi.useRealTimers());
const notify = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  notify.mockClear();
});

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

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
function streamWithWait(
  streamFn: StreamFn,
  options: Parameters<StreamFn>[2],
  thinkingLevel?: ProviderWrapStreamFnContext["thinkingLevel"],
) {
  return wrapLlamaServerStream({
    provider: "llama-cpp",
    modelId: "local",
    streamFn,
    thinkingLevel,
  })({ provider: "llama-cpp" } as never, { messages: [] }, options);
}

function afterPayload(result: ReturnType<StreamFn>): StreamFn {
  return async (model, _context, options) => {
    await options?.onPayload?.({}, model);
    return result;
  };
}

async function applyPayload(
  payload: unknown,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"] = "off",
  options: Parameters<StreamFn>[2] = {},
) {
  let result: unknown;
  await streamWithWait(
    async (model, _context, streamOptions) => {
      result = await streamOptions?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    },
    options,
    thinkingLevel,
  );
  return result;
}

it("maps thinking off to llama-server chat-template kwargs", async () => {
  await expect(
    applyPayload({
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: true },
    }),
  ).resolves.toEqual({
    chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
  });
});

it("does not force thinking on when OpenClaw selected another level", async () => {
  const payload = { model: "model" };
  await expect(applyPayload(payload, "high")).resolves.toBe(payload);
});

it.each([true, false])("normalizes JSON schema embedded in the payload: %s", async (embedded) => {
  const format = { type: "json_schema", json_schema: { name: "openclaw_response", schema } };
  const payload = embedded ? { response_format: format } : {};
  const options = embedded ? {} : { responseFormat: schema };
  await expect(applyPayload(payload, "off", options)).resolves.toMatchObject({
    response_format: { type: "json_object", schema },
  });
});

it("reports a response wait without claiming a slot and clears on first event", async () => {
  const source = createAssistantMessageEventStream();
  const stream = await streamWithWait(
    afterPayload(
      Object.freeze({
        [Symbol.asyncIterator]: () => source[Symbol.asyncIterator](),
        result: () => source.result(),
      }),
    ),
    { onProviderWait: notify },
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
  const controller = new AbortController();
  const pending = Promise.withResolvers<ReturnType<typeof createAssistantMessageEventStream>>();
  const result = Promise.resolve(
    streamWithWait(afterPayload(pending.promise), {
      onProviderWait: notify,
      signal: controller.signal,
    }),
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
  expect(() =>
    streamWithWait(
      (model, _context, options) => {
        void options?.onPayload?.({}, model);
        throw new Error("request stopped");
      },
      { onProviderWait: notify },
    ),
  ).toThrow("request stopped");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(notify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
