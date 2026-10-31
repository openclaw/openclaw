import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { AssistantMessageEvent, Model, SimpleStreamOptions } from "../types.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { isContextOverflow } from "../utils/overflow.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  makeCompletionsChunk as chunk,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";

const contextWindow = 11_564;
const contextCap = 1_563;
const usage = { prompt_tokens: 8_000, completion_tokens: contextCap, total_tokens: 9_563 };
const toolCall = {
  index: 0,
  id: "call-count",
  type: "function",
  function: { name: "count", arguments: '{"amount":1}' },
};
const candidate = { content: "unfinished", tool_calls: [toolCall] };
function frame(value: ChatCompletionChunk) {
  return `data: ${JSON.stringify(value)}\n\n`;
}
function sse(body: BodyInit) {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function runResponse({
  chunks = [chunk({ content: "candidate" }, "length", { usage })],
  response = sse(chunks.map(frame).join("") + "data: [DONE]\n\n"),
  model = {},
  options = {},
  onActivity,
}: {
  chunks?: ChatCompletionChunk[];
  response?: Response;
  model?: Partial<Model<"openai-completions">>;
  options?: SimpleStreamOptions;
  onActivity?: () => void;
} = {}) {
  const previousHost = getAiTransportHost();
  const signal = options.signal ?? new AbortController().signal;
  const activity: boolean[] = [];
  const unsubscribe = onLlmRequestActivity(signal, (progress) => {
    activity.push(progress);
    onActivity?.();
  });
  const onResponse = vi.fn(options.onResponse);
  let request: Record<string, unknown> | undefined;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(await new Request(input, init).text());
    return response;
  });
  configureAiTransportHost({ ...previousHost, buildModelFetch: () => fetch });
  try {
    const selectedModel = makeCompletionsModel({
      provider: "compatible-proxy",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      contextWindow,
      maxTokens: 4_096,
      compat: { maxTokensField: "max_tokens" },
      ...model,
    });
    const stream = await createOpenAICompletionsTransportStreamFn()(
      selectedModel,
      { messages: [{ role: "user", content: "x".repeat(32_000), timestamp: 1 }] },
      { apiKey: "synthetic-test-key", ...options, signal, onResponse },
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(structuredClone(event));
    }
    return { result: await stream.result(), request, events, activity, onResponse };
  } finally {
    unsubscribe();
    configureAiTransportHost(previousHost);
  }
}

it.each(["SSE", "JSON", "cloned SSE"] as const)(
  "rejects capped %s candidates without text or tools",
  async (format) => {
    const finishReason = format === "cloned SSE" ? "length" : "MAX_TOKENS";
    const { result, request, events, onResponse } = await runResponse({
      chunks: [chunk(candidate), chunk({}, finishReason, { usage })],
      options: format === "cloned SSE" ? { onPayload: (payload) => structuredClone(payload) } : {},
      model: { params: { streaming: format !== "JSON" } },
      response:
        format === "JSON"
          ? Response.json({
              choices: [
                { message: { role: "assistant", ...candidate }, finish_reason: finishReason },
              ],
              usage,
            })
          : undefined,
    });
    expect(request).toMatchObject({ max_tokens: contextCap, stream: format !== "JSON" });
    expect(result).toMatchObject({ stopReason: "error", content: [] });
    expect(result.usage).toMatchObject({ input: 8_000, output: contextCap, totalTokens: 9_563 });
    expect(isContextOverflow(result, contextWindow)).toBe(true);
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

it("retains received usage when cancellation takes precedence over a read failure", async () => {
  const controller = new AbortController();
  const consumed = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    async start(stream) {
      stream.enqueue(
        new TextEncoder().encode(frame(chunk({ content: "candidate" }, null, { usage }))),
      );
      await consumed.promise;
      controller.abort();
      stream.error(new Error("synthetic read failure"));
    },
  });
  const { result, events, onResponse } = await runResponse({
    response: sse(body),
    options: { signal: controller.signal },
    onActivity: consumed.resolve,
  });
  expect(result).toMatchObject({ stopReason: "aborted", content: [] });
  expect(result.usage.output).toBe(contextCap);
  expect(isContextOverflow(result, contextWindow)).toBe(false);
  expect(events.map((event) => event.type)).toEqual(["error"]);
  expect(onResponse).toHaveBeenCalledTimes(1);
});

it("keeps incomplete provider streams distinct from context exhaustion", async () => {
  const { result } = await runResponse({
    response: sse(frame(chunk({ content: "unfinished" }))),
  });
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("without finish_reason");
  expect(isContextOverflow(result, contextWindow)).toBe(false);
});

it("observes provider progress once and emits thinking only for reasoning advances", async () => {
  const chunks = [1, 1, 0, 2].map((reasoning_tokens) =>
    chunk({}, null, {
      choices: [],
      usage: {
        prompt_tokens: 8_000,
        completion_tokens: 2,
        total_tokens: 8_002,
        completion_tokens_details: { reasoning_tokens },
      },
    }),
  );
  chunks.push(chunk({ content: "answer" }, "stop"));
  const { activity, events } = await runResponse({ chunks, model: { reasoning: true } });
  expect(activity).toEqual([true, false, false, true, true]);
  expect(
    events.filter((event) => event.type === "thinking_delta").map((event) => event.delta),
  ).toEqual(["", ""]);
});

it("falls back to ordinary length after the raw UTF-8 byte bound", async () => {
  const { result, events, activity } = await runResponse({
    chunks: [
      chunk({ content: "before" }),
      chunk({}, null, { opaque: "界".repeat(1_400_000) }),
      chunk({ content: "after" }, "length", { usage }),
    ],
  });
  expect(result.stopReason).toBe("length");
  expect(isContextOverflow(result, contextWindow)).toBe(false);
  expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual(
    ["before", "after"],
  );
  expect(events.filter((event) => event.type === "start")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
  expect(activity).toEqual([true, false, true]);
});
