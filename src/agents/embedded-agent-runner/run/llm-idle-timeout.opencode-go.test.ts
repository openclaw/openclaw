import type { FirstStreamEventInternalOptions } from "@openclaw/ai/internal/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../../test-utils/plugin-registration.js";
import { classifyFailoverSignalCore } from "../../failover/classify-core.js";
import { shouldRetryFailoverSignal } from "../../failover/retry-evidence.js";
import type { StreamFn } from "../../runtime/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

const { default: plugin } = await loadBundledPluginFacade<{
  default: Parameters<typeof registerSingleProviderPlugin>[0];
}>({ pluginId: "opencode-go", artifactBasename: "index.js" });
const provider = await registerSingleProviderPlugin(plugin);
const model = makeProviderModelFixture({
  api: "openai-completions",
  provider: "opencode-go",
  id: "deepseek-v4-flash",
  name: "Synthetic Go model",
  baseUrl: "https://opencode.ai/zen/go/v1",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 8192,
});

async function openStream(trigger?: "cron", requestTimeoutMs?: number) {
  vi.useFakeTimers();
  const selectedModel = { ...model, requestTimeoutMs };
  const source = createAssistantMessageEventStream();
  let requestOptions: Parameters<StreamFn>[2];
  const base: StreamFn = (_model, _context, options) => {
    requestOptions = options;
    return source;
  };
  const wrapped = provider.wrapStreamFn?.({
    provider: model.provider,
    modelId: model.id,
    model: selectedModel,
    streamFn: base,
  });
  if (!wrapped) {
    throw new Error("Missing registered Go stream wrapper");
  }
  const params = {
    model,
    trigger,
    runTimeoutMs: 900_000,
    modelRequestTimeoutMs: requestTimeoutMs,
  };
  const caller = new AbortController();
  const onTimeout = vi.fn<(error: Error) => void>();
  const options: NonNullable<Parameters<StreamFn>[2]> & FirstStreamEventInternalOptions = {
    signal: caller.signal,
    firstEventTimeoutMs: resolveLlmFirstEventTimeoutMs(params),
  };
  const stream = await streamWithIdleTimeout(wrapped, resolveLlmIdleTimeoutMs(params), onTimeout)(
    selectedModel,
    { messages: [] },
    options,
  );
  return { source, stream, caller, onTimeout, requestOptions };
}

afterEach(() => vi.useRealTimers());

it.each([
  { trigger: undefined, requestMs: undefined, idleMs: 120_000 },
  { trigger: "cron" as const, requestMs: undefined, idleMs: 60_000 },
  { trigger: "cron" as const, requestMs: 2000, idleMs: 2000 },
  { trigger: "cron" as const, requestMs: 600_000, idleMs: 600_000 },
])("keeps missing-EOF recovery at $idleMs ms", async ({ trigger, requestMs, idleMs }) => {
  // Human report #93610: tokens arrived, but the upstream never terminated.
  const { source, stream, onTimeout, requestOptions } = await openStream(trigger, requestMs);
  const partial = makeAgentAssistantMessage({ content: [{ type: "text", text: "hi" }] });
  const iterator = stream[Symbol.asyncIterator]();
  try {
    source.push({ type: "start", partial });
    source.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial });
    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({ value: { delta: "hi" } });
    const pending = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(idleMs - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBe(onTimeout.mock.calls[0]?.[0]);
    expect(error).toHaveProperty("message", expect.stringContaining("LLM idle timeout"));
    expect(requestOptions?.signal?.aborted).toBe(true);
    const signal = { message: onTimeout.mock.calls[0]?.[0].message };
    const classification = classifyFailoverSignalCore(signal);
    expect(classification).toEqual({ kind: "reason", reason: "timeout" });
    expect(shouldRetryFailoverSignal({ classification, signal })).toBe(true);
  } finally {
    source.end();
    await iterator.return?.();
  }
});

it.each(["done", "error"] as const)(
  "leaves raw first-SSE budgets and %s ordering with their owners",
  async (terminal) => {
    for (const requestMs of [undefined, 2000, 600_000]) {
      const { source, stream, onTimeout, requestOptions } = await openStream(undefined, requestMs);
      expect((requestOptions as FirstStreamEventInternalOptions).firstEventTimeoutMs).toBe(
        requestMs ?? 300_000,
      );
      const message = makeAgentAssistantMessage({
        content: [{ type: "text", text: "OK" }],
        stopReason: terminal === "done" ? "stop" : "error",
      });
      source.push({ type: "start", partial: message });
      source.push({ type: "text_delta", contentIndex: 0, delta: "OK", partial: message });
      source.push(
        terminal === "done"
          ? { type: "done", reason: "stop", message }
          : { type: "error", reason: "error", error: message },
      );
      source.end(message);
      const events = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      expect(events).toEqual(["start", "text_delta", terminal]);
      expect(await stream.result()).toBe(message);
      await vi.advanceTimersByTimeAsync(900_000);
      expect(onTimeout).not.toHaveBeenCalled();
    }
  },
);

it("settles caller cancellation without another signal or event queue", async () => {
  const { source, stream, caller, requestOptions, onTimeout } = await openStream();
  const iterator = stream[Symbol.asyncIterator]();
  try {
    const pending = iterator.next().catch((error: unknown) => error);
    const reason = new Error("caller stopped");
    caller.abort(reason);
    await expect(pending).resolves.toMatchObject({ name: "AbortError", cause: reason });
    expect(requestOptions?.signal?.reason).toBe(reason);
    expect(onTimeout).not.toHaveBeenCalled();
  } finally {
    source.end();
    await iterator.return?.();
  }
});
