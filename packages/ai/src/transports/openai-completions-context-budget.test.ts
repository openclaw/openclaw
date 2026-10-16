import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { AssistantMessageEvent, Model, SimpleStreamOptions } from "../types.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { isContextOverflow } from "../utils/overflow.js";
import type { FirstStreamEventInternalOptions } from "../utils/stream-first-event-timeout.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

const contextWindow = 11_564;
const contextCap = 1_563;
const usage = { prompt_tokens: 8_000, completion_tokens: contextCap, total_tokens: 9_563 };
const toolCall = {
  index: 0,
  id: "call-count",
  type: "function",
  function: { name: "count", arguments: '{"amount":1}' },
};

function sse(chunks: ChatCompletionChunk[], done = true) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function runResponse(
  params: {
    chunks?: ChatCompletionChunk[];
    response?: () => Response;
    model?: Partial<Model<"openai-completions">>;
    options?: SimpleStreamOptions & FirstStreamEventInternalOptions;
    onActivity?: () => void;
  } = {},
) {
  const previousHost = getAiTransportHost();
  const controller = new AbortController();
  const signal = params.options?.signal ?? controller.signal;
  const activity: boolean[] = [];
  const unsubscribe = onLlmRequestActivity(signal, (progress) => {
    activity.push(progress);
    params.onActivity?.();
  });
  const onResponse = vi.fn(params.options?.onResponse);
  let request: Record<string, unknown> | undefined;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(await new Request(input, init).text());
    return (
      params.response?.() ??
      sse(params.chunks ?? [makeCompletionsChunk({ content: "candidate" }, "length", { usage })])
    );
  });
  configureAiTransportHost({ ...previousHost, buildModelFetch: () => fetch });
  try {
    const model = makeCompletionsModel({
      provider: "compatible-proxy",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow,
      maxTokens: 4_096,
      compat: { maxTokensField: "max_tokens" },
      ...params.model,
    });
    const stream = await createOpenAICompletionsTransportStreamFn()(
      model,
      { messages: [{ role: "user", content: "x".repeat(32_000), timestamp: 1 }] },
      { apiKey: "synthetic-test-key", ...params.options, signal, onResponse },
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(structuredClone(event));
    }
    return { result: await stream.result(), request, events, activity, fetch, onResponse };
  } finally {
    unsubscribe();
    configureAiTransportHost(previousHost);
  }
}

describe("compatible context-capped responses", () => {
  it.each(["SSE", "JSON"] as const)(
    "rejects capped %s length without publishing candidate text or tools",
    async (format) => {
      const chunks = [
        makeCompletionsChunk({ content: "unfinished", tool_calls: [toolCall] }),
        makeCompletionsChunk({}, "length", { usage }),
      ];
      const { result, request, events, onResponse } = await runResponse({
        chunks,
        ...(format === "JSON"
          ? {
              model: { params: { streaming: false } },
              response: () =>
                Response.json({
                  id: "chatcmpl-json",
                  object: "chat.completion",
                  created: 1,
                  model: "test-model",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "unfinished", tool_calls: [toolCall] },
                      finish_reason: "length",
                    },
                  ],
                  usage,
                }),
            }
          : {}),
      });
      expect(request?.max_tokens).toBe(contextCap);
      expect(request?.stream).toBe(format === "SSE");
      expect(result.stopReason).toBe("error");
      expect(isContextOverflow(result, contextWindow)).toBe(true);
      expect(result.usage).toMatchObject({ input: 8_000, output: contextCap, totalTokens: 9_563 });
      expect(result.content).toEqual([]);
      expect(events.map((event) => event.type)).toEqual(["error"]);
      expect(onResponse).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps ordinary length semantics for the model output ceiling", async () => {
    const { result, events } = await runResponse({
      model: { maxTokens: contextCap },
      options: { maxTokens: 4096 },
    });
    expect(result.stopReason).toBe("length");
    expect(isContextOverflow(result, contextWindow)).toBe(false);
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "candidate" }),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
  });

  it("retains the automatic cap through a payload clone", async () => {
    const { result, events } = await runResponse({
      options: { onPayload: (payload) => structuredClone(payload) },
    });
    expect(isContextOverflow(result, contextWindow)).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  it("retains received usage when cancellation takes precedence over a read failure", async () => {
    const controller = new AbortController();
    const consumed = Promise.withResolvers<void>();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        if (reads++ === 0) {
          stream.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(
                makeCompletionsChunk({ content: "candidate" }, null, { usage }),
              )}\n\n`,
            ),
          );
          return;
        }
        await consumed.promise;
        controller.abort();
        stream.error(new Error("synthetic read failure"));
      },
    });
    const { result, events, onResponse } = await runResponse({
      response: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      options: { signal: controller.signal },
      onActivity: consumed.resolve,
    });
    expect(result.stopReason).toBe("aborted");
    expect(isContextOverflow(result, contextWindow)).toBe(false);
    expect(result.usage.output).toBe(contextCap);
    expect(result.content).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it("keeps incomplete provider streams distinct from context exhaustion", async () => {
    const { result } = await runResponse({
      response: () => sse([makeCompletionsChunk({ content: "unfinished" })], false),
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("without finish_reason");
    expect(isContextOverflow(result, contextWindow)).toBe(false);
  });

  it("observes provider progress once and emits thinking only for reasoning advances", async () => {
    const chunks = [1, 1, 0, 2].map((reasoning_tokens) =>
      makeCompletionsChunk({}, null, {
        choices: [],
        usage: {
          prompt_tokens: 8_000,
          completion_tokens: 2,
          total_tokens: 8_002,
          completion_tokens_details: { reasoning_tokens },
        },
      }),
    );
    chunks.push(makeCompletionsChunk({ content: "answer" }, "stop"));
    const { activity, events } = await runResponse({ chunks, model: { reasoning: true } });
    expect(activity).toEqual([true, false, false, true, true]);
    expect(
      events.filter((event) => event.type === "thinking_delta").map((event) => event.delta),
    ).toEqual(["", ""]);
  });

  it("falls back to ordinary length after the raw UTF-8 byte bound", async () => {
    const controls = [makeCompletionsChunk({}, null, { opaque: "界".repeat(1_400_000) })];
    const { result, events, activity } = await runResponse({
      chunks: [
        makeCompletionsChunk({ content: "before" }),
        ...controls,
        makeCompletionsChunk({ content: "after" }, "length", { usage }),
      ],
    });
    expect(result.stopReason).toBe("length");
    expect(isContextOverflow(result, contextWindow)).toBe(false);
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ).toEqual(["before", "after"]);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
    expect(activity).toEqual([true, ...controls.map(() => false), true]);
  });
});
