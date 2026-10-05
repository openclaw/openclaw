import { describe, expect, it, vi } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  expectRecordFields,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";
import { parseOpenAICompletionsUsage } from "./openai-transport-shared.js";

const pricedModel = makeCompletionsModel({
  id: "gpt-5",
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
});
const openRouterModel = makeCompletionsModel({
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
});
type RawUsage = Parameters<typeof parseOpenAICompletionsUsage>[0];
type UsageCase = {
  name: string;
  usage: RawUsage;
  expected: Record<string, unknown>;
  model?: typeof pricedModel;
};
const usageCases: UsageCase[] = [
  {
    name: "missing total tokens",
    usage: { prompt_tokens: 10, completion_tokens: 5 } as RawUsage,
    expected: { contextUsage: { state: "unavailable" } },
  },
  {
    name: "total below prompt and completion tokens",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 14 },
    expected: { contextUsage: { state: "unavailable" } },
  },
  {
    name: "reasoning tokens without double-counting",
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 7 },
    },
    expected: {
      input: 7,
      output: 20,
      cacheRead: 3,
      reasoningTokens: 7,
      totalTokens: 30,
      contextUsage: { state: "available", promptTokens: 10, totalTokens: 30 },
    },
  },
  {
    name: "separate cache write count",
    model: openRouterModel,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    },
    expected: {
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 15,
      contextUsage: { state: "available", promptTokens: 10, totalTokens: 15 },
    },
  },
  {
    name: "uncached prompt usage clamped at zero",
    usage: {
      prompt_tokens: 2,
      completion_tokens: 5,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 4 },
    },
    expected: {
      input: 0,
      output: 5,
      cacheRead: 4,
      totalTokens: 9,
      contextUsage: { state: "unavailable" },
    },
  },
];

function usageChunk(completionTokens: number, reasoningTokens?: number) {
  return makeCompletionsChunk({}, null, {
    choices: [],
    usage: {
      prompt_tokens: 8,
      completion_tokens: completionTokens,
      total_tokens: 8 + completionTokens,
      ...(reasoningTokens === undefined
        ? {}
        : {
            completion_tokens_details: { reasoning_tokens: reasoningTokens },
          }),
    },
  });
}
async function runChunks(chunks: readonly unknown[], model = makeCompletionsModel()) {
  const output = createAssistantOutput(model);
  const events: CapturedStreamEvent[] = [];
  await processCompletionsStream(streamChunks(chunks), output, model, {
    push: (event) => events.push(event),
  });
  return { output, events };
}

describe("openai completions stream", () => {
  it.each(usageCases)("parses $name", ({ usage, expected, model = pricedModel }) => {
    expectRecordFields(parseOpenAICompletionsUsage(usage, model), expected);
  });

  it.each([0, -1])("uses provider cost only when valid: %s", (cost) => {
    const usage = parseOpenAICompletionsUsage(
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost,
      },
      openRouterModel,
    );
    if (cost === 0) {
      expect(usage.cost.total).toBe(0);
      expect(usage.cost.totalOrigin).toBe("provider-billed");
    } else {
      expect(usage.cost.total).toBeCloseTo(0.00002);
      expect(usage.cost.totalOrigin).toBeUndefined();
    }
  });

  it.each(["ordinary", "reasoning before text", "reasoning after text"] as const)(
    "handles %s usage chunks",
    async (kind) => {
      const ordinary = kind === "ordinary";
      const before = kind === "reasoning before text";
      const text = makeCompletionsChunk(
        { role: "assistant", content: ordinary ? "ok" : "Hi" },
        before || ordinary ? "stop" : null,
      );
      const usage = usageChunk(ordinary ? 10 : before ? 23 : 25, ordinary ? undefined : 23);
      const { output, events } = await runChunks(
        before ? [usage, text] : [text, usage],
        makeCompletionsModel(
          ordinary
            ? {
                id: "glm-5",
                provider: "vllm",
                baseUrl: "http://localhost:8000/v1",
                reasoning: false,
              }
            : {
                id: "google/gemini-2.5-flash",
                provider: "vertex-ai",
                baseUrl:
                  "http://127.0.0.1:8787/v1beta1/projects/test/locations/us/endpoints/openapi",
              },
        ),
      );
      if (ordinary) {
        expectRecordFields(output.usage, {
          input: 8,
          output: 10,
          cacheRead: 0,
          totalTokens: 18,
          contextUsage: { state: "available", promptTokens: 8, totalTokens: 18 },
        });
      } else {
        expect(events.map((event) => event.type)).toEqual(
          before
            ? ["thinking_start", "thinking_delta", "text_start", "text_delta"]
            : ["text_start", "text_delta"],
        );
        expect(output.content).toEqual(
          before
            ? [
                { type: "thinking", thinking: "" },
                { type: "text", text: "Hi" },
              ]
            : [{ type: "text", text: "Hi" }],
        );
        if (before) {
          expect(events[1]).toHaveProperty("delta", "");
        }
      }
    },
  );

  it("yields to aborts during bursty OpenAI-compatible streams", async () => {
    const model = makeCompletionsModel({
      id: "deepseek-v4-flash",
      provider: "opencode-go",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
    });
    const output = createAssistantOutput(model);
    const abort = new AbortController();
    const stream = { push: vi.fn() };
    let yieldedToTimer = false;

    async function* mockStream() {
      for (let index = 0; index < 512; index += 1) {
        yield makeCompletionsChunk({ role: "assistant" as const, content: "x" });
      }
    }

    setTimeout(() => {
      yieldedToTimer = true;
      abort.abort();
    }, 0);

    await expect(
      processCompletionsStream(mockStream(), output, model, stream, {
        signal: abort.signal,
      }),
    ).rejects.toThrow("Request was aborted");
    expect(yieldedToTimer).toBe(true);
    expect(stream.push.mock.calls.length).toBeLessThan(512);
  });

  it("does not finalize tool calls when cancellation ends the iterator normally", async () => {
    const model = makeCompletionsModel();
    const output = createAssistantOutput(model);
    const abort = new AbortController();
    const events: CapturedStreamEvent[] = [];

    async function* silentlyAbortedStream() {
      yield makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_aborted",
              type: "function",
              function: { name: "read", arguments: '{"path":"example.txt"}' },
            },
          ],
        },
        "stop",
      );
      abort.abort();
    }

    await expect(
      processCompletionsStream(
        silentlyAbortedStream(),
        output,
        model,
        { push: (event) => events.push(event as CapturedStreamEvent) },
        { signal: abort.signal },
      ),
    ).rejects.toThrow("Request was aborted");
    expect(events.map((event) => event.type)).toEqual(["toolcall_start", "toolcall_delta"]);
    expect(output.stopReason).not.toBe("toolUse");
  });

  it.each([
    {
      name: "incremental text without accumulated snapshots",
      model: makeCompletionsModel({
        id: "dense-local",
        provider: "local",
        baseUrl: "http://127.0.0.1:18065/v1",
        reasoning: false,
      }),
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: "a" }),
        makeCompletionsChunk({ content: "b" }),
      ],
      text: "ab",
      deltas: ["a", "b"],
    },
    {
      name: "null and non-object chunks",
      model: makeCompletionsModel({
        id: "glm-5",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
      }),
      chunks: [
        null,
        "not-a-chunk",
        makeCompletionsChunk({ role: "assistant", content: "ok" }, "stop"),
      ],
      text: "ok",
      deltas: ["ok"],
    },
    {
      name: "visible refusal deltas",
      model: makeCompletionsModel({ id: "gpt-5.5", reasoning: false }),
      chunks: [
        makeCompletionsChunk(
          { role: "assistant", content: null, refusal: "I can't help with that." },
          "stop",
        ),
      ],
      text: "I can't help with that.",
      deltas: ["I can't help with that."],
    },
  ])("renders $name", async ({ chunks, text, deltas, model }) => {
    const { output, events } = await runChunks(chunks, model);
    expect(output.content).toStrictEqual([{ type: "text", text }]);
    expect(output.stopReason).toBe("stop");
    const textDeltas = events.filter((event) => event.type === "text_delta");
    expect(textDeltas.map((event) => event.delta)).toEqual(deltas);
    expect(textDeltas.every((event) => !("partial" in event))).toBe(true);
  });
});
