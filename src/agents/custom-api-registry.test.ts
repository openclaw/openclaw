import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { getEventStreamCompletion } from "@openclaw/ai/internal/runtime";
import { resetApiProviders } from "@openclaw/ai/providers";
import type { AssistantMessageEvent, StreamFn } from "@openclaw/llm-core";
import { expect, it, vi } from "vitest";
import { collect } from "../../test/helpers/async-iterable.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const model = makeProviderModelFixture({ api: "custom", provider: "custom", id: "m", baseUrl: "" });
const usage = buildUsageWithNoCost({});
const message = buildAssistantMessage({ model, content: [], stopReason: "stop", usage });
const repaired: typeof message = { ...message, content: [{ type: "text", text: "repaired" }] };
const context = { messages: [] };
function runtime(factory: StreamFn) {
  const registry = createApiRegistry();
  ensureCustomApiRegistered(registry, model.api, factory);
  return createLlmRuntime(registry);
}

it("registers once, preserves producers and lazy results, and survives builtin refresh", async () => {
  const registry = createApiRegistry();
  const result = vi.fn(async () => repaired);
  const source = Object.assign(createAssistantMessageEventStream(), { result });
  const factory = () => source;
  expect(ensureCustomApiRegistered(registry, model.api, factory)).toBe(true);
  expect(ensureCustomApiRegistered(registry, model.api, factory)).toBe(false);
  resetApiProviders(registry);
  const provider = registry.getApiProvider(model.api)!;
  expect(provider.stream(model, context, {})).toBe(source);
  expect(provider.streamSimple(model, context, {})).toBe(source);
  const stream = createLlmRuntime(registry).stream(model, context);
  expect(getEventStreamCompletion(stream)).toBe(getEventStreamCompletion(source));
  source.push({ type: "done", reason: "stop", message });
  await expect(getEventStreamCompletion(stream)).resolves.toBe(message);
  expect(result).not.toHaveBeenCalled();
  await expect(stream.result()).resolves.toBe(repaired);
  expect(registry.getApiProvider("openai-responses")).toBeDefined();
});

it.for(["sync", "async"])("preserves %s readonly events and independent results", async (kind) => {
  const events: AssistantMessageEvent[] = [
    { type: "text_delta", contentIndex: 0, delta: "done", partial: message },
    { type: "done", reason: "stop", message },
  ];
  const source = Object.freeze({
    result: async () => repaired,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  });
  const rt = runtime(() => (kind === "sync" ? source : Promise.resolve(source)));
  const stream = rt.stream(model, context),
    result = stream.result();
  expect(await collect(stream)).toEqual(events);
  await expect(getEventStreamCompletion(stream)).resolves.toBe(message);
  await expect(result).resolves.toBe(repaired);
  await expect(rt.completeSimple(model, context)).resolves.toBe(repaired);
});

it.for(["factory", "result"])("reports %s failure through the actual runtime", async (phase) => {
  const rt = runtime(() =>
    phase === "factory"
      ? Promise.reject(new Error("factory failed"))
      : Promise.resolve({
          result: () => Promise.reject(new Error("result failed")),
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: "stop", message } as const;
          },
        }),
  );
  await expect(rt.completeSimple(model, context)).resolves.toMatchObject({
    stopReason: "error",
    errorMessage: `${phase} failed`,
  });
});
