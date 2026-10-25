import { createLlmRuntime } from "@openclaw/ai";
import { onLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { createAssistantMessageEventStream, EventStream } from "@openclaw/llm-core/event-stream";
import type { AssistantMessageEvent } from "@openclaw/llm-core/types";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeOpenAICompletionsProgress,
  processCompletionsStream,
} from "../../../../packages/ai/src/transports/openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "../../../../packages/ai/src/transports/openai-completions.test-support.js";
import { processResponsesStream } from "../../../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { failTransportStream } from "../../../../packages/ai/src/transports/transport-stream-shared.js";
import { classifyFailoverSignalCore } from "../../failover/classify-core.js";
import { shouldRetryFailoverSignal } from "../../failover/retry-evidence.js";
import type { StreamFn } from "../../runtime/index.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import { resolveLlmIdleTimeoutMs, streamWithIdleTimeout } from "./llm-idle-timeout.js";

const model = makeCompletionsModel({ reasoning: false });

async function openStream(
  scope: "creation-and-gaps" | "creation-only" = "creation-and-gaps",
  timeoutMs = 100,
) {
  const chunks = new EventStream<ChatCompletionChunk, boolean>(
    () => false,
    () => true,
  );
  const output = createAssistantOutput(model);
  const activity: boolean[] = [];
  const onTimeout = vi.fn<(error: Error) => void>();
  let onChunkActivity: (() => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  const providerStreamFn: StreamFn = (_model, _context, options) => {
    requestSignal = options?.signal;
    if (!requestSignal) {
      throw new Error("Missing request signal");
    }
    const unsubscribe = onLlmRequestActivity(requestSignal, (progress) => {
      activity.push(progress);
      onChunkActivity?.();
    });
    const stopChunks = () => chunks.end(true);
    requestSignal.addEventListener("abort", stopChunks, { once: true });
    const stream = createAssistantMessageEventStream();
    void processCompletionsStream(
      observeOpenAICompletionsProgress(chunks, requestSignal),
      output,
      model,
      stream,
      { signal: requestSignal, emitReasoning: false },
    )
      .then(
        () => stream.end(output),
        (error: unknown) =>
          stream.push({
            type: "error",
            reason: "aborted",
            error: { ...output, stopReason: "aborted", errorMessage: String(error) },
          }),
      )
      .finally(() => {
        unsubscribe();
        requestSignal?.removeEventListener("abort", stopChunks);
      });
    return stream;
  };
  const { streamFn } = resolveEmbeddedAgentStream({
    llmRuntime: createLlmRuntime(),
    currentStreamFn: undefined,
    providerStreamFn,
    sessionId: "progress-deadline",
    model,
    signal: new AbortController().signal,
  });
  const stream = await streamWithIdleTimeout(streamFn, timeoutMs, onTimeout, { scope })(model, {
    messages: [],
  });
  const events: AssistantMessageEvent[] = [];
  const completion = (async () => {
    for await (const event of stream) {
      events.push(event);
    }
  })().catch((error: unknown) => error);
  return {
    activity,
    events,
    onTimeout,
    completion,
    requestSignal,
    async send(chunk: ChatCompletionChunk) {
      const observed = Promise.withResolvers<void>();
      onChunkActivity = observed.resolve;
      chunks.push(chunk);
      // Advance the fake clock only after the real stream consumes this chunk.
      await observed.promise;
      onChunkActivity = undefined;
      await vi.advanceTimersByTimeAsync(0);
    },
    async close() {
      chunks.end(true);
      await vi.advanceTimersByTimeAsync(0);
      await completion;
    },
  };
}

async function withStream(
  use: (stream: Awaited<ReturnType<typeof openStream>>) => Promise<void>,
  ...options: Parameters<typeof openStream>
) {
  vi.useFakeTimers();
  const stream = await openStream(...options);
  try {
    await use(stream);
  } finally {
    await stream.close();
  }
  return stream;
}

afterEach(() => vi.useRealTimers());

it("aborts content-free chunks at twice the idle window through composed run signals", async () => {
  const chunk = makeCompletionsChunk({ role: "assistant", content: "" });
  await withStream(async (stream) => {
    await stream.send(makeCompletionsChunk({ role: "assistant" }));
    for (const elapsed of [40, 40, 40, 40, 39]) {
      await vi.advanceTimersByTimeAsync(elapsed);
      await stream.send(chunk);
      expect(stream.onTimeout).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.onTimeout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "LlmNoProgressError",
        message: "LLM idle timeout (0s): no model progress",
      }),
    );
    expect(stream.requestSignal?.aborted).toBe(true);
    expect(await stream.completion).toBe(stream.onTimeout.mock.calls[0]?.[0]);
    expect(stream.events).toEqual([]);
    expect(stream.activity).toEqual(Array(6).fill(false));
    const signal = { message: stream.onTimeout.mock.calls[0]?.[0].message };
    const classification = classifyFailoverSignalCore(signal);
    expect(classification).toEqual({ kind: "reason", reason: "timeout" });
    expect(shouldRetryFailoverSignal({ classification, signal })).toBe(true);
  });
});

it("aborts Responses silence 120 seconds after initial events through composed run signals", async () => {
  vi.useFakeTimers();
  const responsesModel = { ...model, api: "openai-responses" as const };
  const output = { ...createAssistantOutput(model), api: "openai-responses" as const };
  const rawEvents = new EventStream<unknown, boolean>(
    () => false,
    () => true,
  );
  const onTimeout = vi.fn<(error: Error) => void>();
  let requestSignal: AbortSignal | undefined;
  let producerCompletion: Promise<void> | undefined;
  const providerStreamFn: StreamFn = (_model, _context, options) => {
    requestSignal = options?.signal;
    const stopEvents = () => rawEvents.end(true);
    requestSignal?.addEventListener("abort", stopEvents, { once: true });
    const stream = createAssistantMessageEventStream();
    producerCompletion = processResponsesStream(rawEvents, output, stream, responsesModel, {
      signal: requestSignal,
    })
      .then(
        () => stream.end(output),
        (error: unknown) => failTransportStream({ stream, output, signal: requestSignal, error }),
      )
      .finally(() => requestSignal?.removeEventListener("abort", stopEvents));
    return stream;
  };
  const { streamFn } = resolveEmbeddedAgentStream({
    llmRuntime: createLlmRuntime(),
    currentStreamFn: undefined,
    providerStreamFn,
    sessionId: "responses-silence",
    model: responsesModel,
    signal: new AbortController().signal,
  });
  const stream = await streamWithIdleTimeout(
    streamFn,
    resolveLlmIdleTimeoutMs({ model: responsesModel }),
    onTimeout,
  )(responsesModel, { messages: [] });
  const events: AssistantMessageEvent[] = [];
  const completion = (async () => {
    for await (const event of stream) {
      events.push(event);
    }
  })().catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    rawEvents.push({ type: "response.created", response: { id: "resp_silent" } });
    await vi.advanceTimersByTimeAsync(30_000);
    rawEvents.push({ type: "response.in_progress", response: { id: "resp_silent" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(output.responseId).toBe("resp_silent");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "LLM idle timeout (120s): no response from model" }),
    );
    expect(requestSignal?.aborted).toBe(true);
    expect(await completion).toBe(onTimeout.mock.calls[0]?.[0]);
    expect(events).toEqual([]);
    await producerCompletion;
  } finally {
    rawEvents.end(true);
    await completion;
    await producerCompletion;
  }
});

it("allows 1095 seconds of hidden reasoning while the 120-second idle watchdog sees progress", async () => {
  const stream = await withStream(
    async (active) => {
      for (let index = 0; index < 15; index += 1) {
        await vi.advanceTimersByTimeAsync(73_000);
        await active.send(makeCompletionsChunk({ reasoning_content: "x" }));
      }
      expect(active.onTimeout).not.toHaveBeenCalled();
      expect(active.requestSignal?.aborted).toBe(false);
      expect(active.activity).toHaveLength(15);
      expect(active.events.filter((event) => event.type === "thinking_delta")).toEqual([]);
      await active.send(makeCompletionsChunk({ content: "OK" }, "stop"));
    },
    "creation-and-gaps",
    120_000,
  );
  expect(await stream.completion).toBeUndefined();
  expect(
    stream.events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])).join(""),
  ).toBe("OK");
  await vi.advanceTimersByTimeAsync(500);
  expect(stream.onTimeout).not.toHaveBeenCalled();
});

it("counts legacy tool fragments and reasoning buffered behind them as progress", async () => {
  const stream = await withStream(async (active) => {
    await active.send(makeCompletionsChunk({ function_call: { name: "read", arguments: "{}" } }));
    for (let index = 0; index < 8; index += 1) {
      await vi.advanceTimersByTimeAsync(80);
      await active.send(
        makeCompletionsChunk(
          index < 4
            ? { function_call: { arguments: " " } }
            : { reasoning_content: "private thought" },
        ),
      );
    }
    expect(active.onTimeout).not.toHaveBeenCalled();
    expect(active.requestSignal?.aborted).toBe(false);
    expect(active.events).toEqual([]);
    await active.send(makeCompletionsChunk({}, "function_call"));
  });
  expect(await stream.completion).toBeUndefined();
  expect(stream.events.find((event) => event.type === "toolcall_end")?.toolCall).toEqual(
    expect.objectContaining({ name: "read", arguments: {} }),
  );
});

it("preserves the local endpoint gap opt-out", async () => {
  expect(resolveLlmIdleTimeoutMs({ model: { baseUrl: "http://localhost:1234" } })).toBe(0);
  await withStream(async (stream) => {
    await stream.send(makeCompletionsChunk({}, null, { choices: [] }));
    await vi.advanceTimersByTimeAsync(500);
    expect(stream.onTimeout).not.toHaveBeenCalled();
    expect(stream.requestSignal?.aborted).toBe(false);
  }, "creation-only");
});
