import { createLlmRuntime } from "@openclaw/ai";
import { onLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { createAssistantMessageEventStream, EventStream } from "@openclaw/llm-core/event-stream";
import type { AssistantMessageEvent } from "@openclaw/llm-core/types";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeOpenAICompletionsProgress,
  processCompletionsStream,
} from "../../../../packages/ai/src/transports/openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "../../../../packages/ai/src/transports/openai-completions.test-support.js";
import { classifyFailoverSignalCore } from "../../failover/classify-core.js";
import { shouldRetryFailoverSignal } from "../../failover/retry-evidence.js";
import type { StreamFn } from "../../runtime/index.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import { resolveLlmIdleTimeoutMs, streamWithIdleTimeout } from "./llm-idle-timeout.js";

const model = makeCompletionsModel({ reasoning: false });
const idleMs = 100;

async function openStream(scope: "creation-and-gaps" | "creation-only" = "creation-and-gaps") {
  const chunks = new EventStream<ChatCompletionChunk, boolean>(
    () => false,
    () => true,
  );
  const output = createAssistantOutput(model);
  const activity: boolean[] = [];
  const onTimeout = vi.fn<(error: Error) => void>();
  const runAbort = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const providerStreamFn: StreamFn = (_model, _context, options) => {
    requestSignal = options?.signal;
    if (!requestSignal) {
      throw new Error("Missing request signal");
    }
    const unsubscribe = onLlmRequestActivity(requestSignal, (progress) => activity.push(progress));
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
        (error: unknown) => {
          stream.push({
            type: "error",
            reason: "aborted",
            error: { ...output, stopReason: "aborted", errorMessage: String(error) },
          });
        },
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
    signal: runAbort.signal,
  });
  const stream = await streamWithIdleTimeout(streamFn, idleMs, onTimeout, { scope })(model, {
    messages: [],
  });
  const events: AssistantMessageEvent[] = [];
  const completion = (async () => {
    try {
      for await (const event of stream) {
        events.push(event);
      }
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  return {
    activity,
    events,
    onTimeout,
    completion,
    requestSignal,
    async send(chunk: ChatCompletionChunk) {
      chunks.push(chunk);
      await vi.advanceTimersByTimeAsync(0);
    },
    async close() {
      chunks.end(true);
      await vi.advanceTimersByTimeAsync(0);
      await completion;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("completions model-progress deadline", () => {
  it("aborts content-free chunks at twice the idle window through composed run signals", async () => {
    vi.useFakeTimers();
    const chunk = makeCompletionsChunk({ role: "assistant", content: "" });
    const stream = await openStream();
    try {
      await stream.send(makeCompletionsChunk({ role: "assistant" }));
      for (let elapsed = 40; elapsed < 200; elapsed += 40) {
        await vi.advanceTimersByTimeAsync(40);
        await stream.send(chunk);
        expect(stream.onTimeout).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(39);
      await stream.send(chunk);
      expect(stream.onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.onTimeout).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "LLM idle timeout (0s): no model progress" }),
      );
      expect(stream.requestSignal?.aborted).toBe(true);
      const error = await stream.completion;
      expect(error).toBe(stream.onTimeout.mock.calls[0]?.[0]);
      expect(stream.events).toEqual([]);
      expect(stream.activity).toEqual(Array(6).fill(false));
      const signal = { message: stream.onTimeout.mock.calls[0]?.[0].message };
      const classification = classifyFailoverSignalCore(signal);
      expect(classification).toEqual({ kind: "reason", reason: "timeout" });
      expect(shouldRetryFailoverSignal({ classification, signal })).toBe(true);
    } finally {
      await stream.close();
    }
  });

  it("keeps hidden reasoning progress alive beyond both windows", async () => {
    vi.useFakeTimers();
    const stream = await openStream();
    try {
      for (let index = 0; index < 8; index += 1) {
        await vi.advanceTimersByTimeAsync(40);
        await stream.send(makeCompletionsChunk({ reasoning_content: "x" }));
      }
      expect(stream.onTimeout).not.toHaveBeenCalled();
      expect(stream.requestSignal?.aborted).toBe(false);
      expect(stream.activity).toHaveLength(8);
      expect(stream.events.filter((event) => event.type === "thinking_delta")).toEqual([]);
      await stream.send(makeCompletionsChunk({ content: "OK" }, "stop"));
    } finally {
      await stream.close();
    }
    expect(await stream.completion).toBeUndefined();
    expect(
      stream.events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe("OK");
    await vi.advanceTimersByTimeAsync(500);
    expect(stream.onTimeout).not.toHaveBeenCalled();
  });

  it("counts legacy tool fragments and reasoning buffered behind them as progress", async () => {
    vi.useFakeTimers();
    const stream = await openStream();
    try {
      await stream.send(makeCompletionsChunk({ function_call: { name: "read", arguments: "{}" } }));
      for (let index = 0; index < 8; index += 1) {
        await vi.advanceTimersByTimeAsync(80);
        await stream.send(
          makeCompletionsChunk(
            index < 4
              ? { function_call: { arguments: " " } }
              : { reasoning_content: "private thought" },
          ),
        );
      }
      expect(stream.onTimeout).not.toHaveBeenCalled();
      expect(stream.requestSignal?.aborted).toBe(false);
      expect(stream.events).toEqual([]);
      await stream.send(makeCompletionsChunk({}, "function_call"));
    } finally {
      await stream.close();
    }
    expect(await stream.completion).toBeUndefined();
    expect(stream.events).toContainEqual(
      expect.objectContaining({
        type: "toolcall_end",
        toolCall: expect.objectContaining({ name: "read", arguments: {} }),
      }),
    );
  });

  it("preserves the local endpoint gap opt-out", async () => {
    vi.useFakeTimers();
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl: "http://localhost:1234" } })).toBe(0);
    const stream = await openStream("creation-only");
    try {
      await stream.send(makeCompletionsChunk({}, null, { choices: [] }));
      await vi.advanceTimersByTimeAsync(500);
      expect(stream.onTimeout).not.toHaveBeenCalled();
      expect(stream.requestSignal?.aborted).toBe(false);
    } finally {
      await stream.close();
    }
  });
});
