import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import type { AssistantMessageEvent, ToolCall } from "../types.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { isContextOverflow } from "../utils/overflow.js";
import { bufferContextLimitedCompletions } from "./openai-completions-context-budget-buffer.js";
import * as completionsStream from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

async function runBufferedResponse(
  chunks: ChatCompletionChunk[],
  options?: Pick<OpenAICompletionsOptions, "signal" | "onResponse"> & {
    firstEventTimeoutMs?: number;
    onFirstEventTimeout?: (error: Error) => void;
  },
  body?: ReadableStream<Uint8Array>,
) {
  const previousHost = getAiTransportHost();
  let request: Record<string, unknown> | undefined;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(await new Request(input, init).text());
    return new Response(
      body ??
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  configureAiTransportHost({ ...previousHost, buildModelFetch: () => fetch });
  try {
    const model = makeCompletionsModel({
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      contextWindow: 11_564,
      maxTokens: 4_096,
      compat: { maxTokensField: "max_tokens" },
    });
    const stream = await createOpenAICompletionsTransportStreamFn()(
      model,
      { messages: [{ role: "user", content: "x".repeat(32_000), timestamp: 1 }] },
      { apiKey: "test-key", ...options },
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(structuredClone(event));
    }
    return { result: await stream.result(), request, events, fetch };
  } finally {
    configureAiTransportHost(previousHost);
  }
}

describe("context-limited completions with many provider chunks", () => {
  it("recovers length after 1600 reasoning chunks without exposing candidate events", async () => {
    const chunks = Array.from({ length: 1600 }, () =>
      makeCompletionsChunk({ reasoning_content: "x" }),
    );
    chunks.push(
      makeCompletionsChunk({}, "length", {
        usage: { prompt_tokens: 8_000, completion_tokens: 1563, total_tokens: 9_563 },
      }),
    );
    const { result, request, events, fetch } = await runBufferedResponse(chunks);
    expect(request?.max_tokens).toBe(1563);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("error");
    expect(isContextOverflow(result, 11_564)).toBe(true);
    expect(result.usage.output).toBe(1563);
    expect(result.content).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  it("does not admit an async tool after the old event-count bound", async () => {
    const originalProcess = completionsStream.processCompletionsStream;
    const producer = vi
      .spyOn(completionsStream, "processCompletionsStream")
      .mockImplementation(async (source, output, model, events, options) => {
        let deltas = 0;
        await originalProcess(
          source,
          output,
          model,
          {
            push(event) {
              events.push(event);
              if (event.type === "thinking_delta" && ++deltas === 300) {
                const toolCall: ToolCall = {
                  type: "toolCall",
                  id: "async-write",
                  name: "write",
                  arguments: { path: "a" },
                  async: true,
                };
                events.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: output });
              }
            },
          },
          options,
        );
      });
    try {
      const chunks = Array.from({ length: 320 }, () =>
        makeCompletionsChunk({ reasoning_content: "x" }),
      );
      chunks.push(makeCompletionsChunk({}, "length"));
      const { result, events } = await runBufferedResponse(chunks);
      expect(producer).toHaveBeenCalledTimes(1);
      expect(isContextOverflow(result, 11_564)).toBe(true);
      expect(events.map((event) => event.type)).toEqual(["error"]);
    } finally {
      producer.mockRestore();
    }
  });

  it("keeps successful reasoning events in order beyond the old snapshot bounds", async () => {
    const deltas = Array.from({ length: 320 }, (_, index) => `${index},`);
    const { result, events } = await runBufferedResponse([
      ...deltas.map((reasoning_content) => makeCompletionsChunk({ reasoning_content })),
      makeCompletionsChunk({ content: "answer" }, "stop"),
    ]);
    expect(result.stopReason).toBe("stop");
    expect(events[0]).toMatchObject({ type: "start", partial: { content: [] } });
    expect(
      events.filter((event) => event.type === "thinking_delta").map((event) => event.delta),
    ).toEqual(deltas);
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ).toEqual(["answer"]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });

  it("preserves length and original event order after the raw-byte bound", async () => {
    const deltas = ["prefix", "x".repeat(4 * 1024 * 1024), "tail"];
    const { result, events, fetch } = await runBufferedResponse([
      ...deltas.map((content) => makeCompletionsChunk({ content })),
      makeCompletionsChunk({}, "length"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("length");
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ).toEqual(deltas);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it.each([false, true])(
    "retains received usage on a buffered read failure (abort=%s)",
    async (abort) => {
      const controller = new AbortController();
      const activity = vi.fn();
      const stopActivity = onLlmRequestActivity(controller.signal, activity);
      const onResponse = vi.fn();
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          if (reads++ === 0) {
            stream.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(
                  makeCompletionsChunk({ reasoning_content: "candidate" }, null, {
                    usage: { prompt_tokens: 8000, completion_tokens: 121, total_tokens: 8121 },
                  }),
                )}\n\n`,
              ),
            );
          } else {
            // Leave the queued first chunk readable before terminating the stream.
            setTimeout(() => {
              if (abort) {
                controller.abort();
              }
              stream.error(new Error("synthetic connection failure"));
            }, 0);
          }
        },
      });
      try {
        const { result, events } = await runBufferedResponse(
          [],
          { signal: controller.signal, onResponse },
          body,
        );
        expect(result.stopReason).toBe(abort ? "aborted" : "error");
        expect(result.usage.output).toBe(121);
        expect(isContextOverflow(result, 11_564)).toBe(false);
        expect(result.content).toEqual([]);
        expect(events.map((event) => event.type)).toEqual(["error"]);
        expect(onResponse).toHaveBeenCalledTimes(1);
        expect(activity).toHaveBeenCalled();
      } finally {
        stopActivity();
      }
    },
  );

  it("times out the first real provider chunk and calls the response hook only once", async () => {
    const onResponse = vi.fn();
    const onFirstEventTimeout = vi.fn();
    let closeBody: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        closeBody = () => controller.close();
      },
      cancel() {
        closeBody = undefined;
      },
    });
    try {
      const { result, events } = await runBufferedResponse(
        [],
        {
          onResponse,
          onFirstEventTimeout,
          firstEventTimeoutMs: 10,
        },
        body,
      );
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("first-event timeout");
      expect(isContextOverflow(result, 11_564)).toBe(false);
      expect(events.map((event) => event.type)).toEqual(["error"]);
      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(onFirstEventTimeout).toHaveBeenCalledTimes(1);
    } finally {
      closeBody?.();
    }
  });

  it("keeps tolerating null and primitive provider control chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: null\n\ndata: 42\n\ndata: {}\n\n" +
              `data: ${JSON.stringify(makeCompletionsChunk({ content: "candidate" }, "length"))}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    });
    const { result, events } = await runBufferedResponse([], undefined, body);
    expect(isContextOverflow(result, 11_564)).toBe(true);
    expect(result.errorMessage).not.toContain("TypeError");
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });
});

describe("raw context-budget buffer bounds", () => {
  it("joins an over-count prefix to its original iterator without reading twice", async () => {
    const chunks = Array.from({ length: 8194 }, (_, index) =>
      makeCompletionsChunk({ content: String(index) }),
    );
    let reads = 0;
    let closed = false;
    async function* source() {
      try {
        for (const chunk of chunks) {
          reads++;
          yield chunk;
        }
      } finally {
        closed = true;
      }
    }
    const buffered = await bufferContextLimitedCompletions(source());
    expect(buffered.bounded).toBe(false);
    expect(reads).toBe(8193);
    const actual = [];
    for await (const chunk of buffered.stream) {
      actual.push(chunk);
    }
    expect(actual).toEqual(chunks);
    expect(reads).toBe(chunks.length);
    expect(closed).toBe(true);
  });
});
