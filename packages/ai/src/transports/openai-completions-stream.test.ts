import { describe, expect, it, vi } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import { streamFixture } from "./openai-completions-suite.test-support.js";
import {
  type CapturedStreamEvent,
  type OpenAICompletionsOutput,
  createAssistantOutput,
  createDeepSeekCompletionsModel,
  expectRecordFields,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

const miniMax = makeCompletionsModel({
  id: "MiniMax-M2.7",
  name: "MiniMax M2.7",
  provider: "minimax",
  baseUrl: "https://api.minimax.test/v1",
});

const routerMiniMax = makeCompletionsModel({
  id: "openrouter/minimax/minimax-m2.7",
  name: "MiniMax M2.7",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
});
function expectedToolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}
function expectedThinking(thinking: string) {
  return { type: "thinking", thinking, thinkingSignature: "reasoning_details" };
}

function collectVisibleText(output: OpenAICompletionsOutput): string {
  return output.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function toolDelta(args: string, name: string | undefined, id: string, index?: number) {
  return {
    tool_calls: [
      {
        ...(index === undefined ? {} : { index }),
        id,
        type: "function",
        function: { ...(name ? { name } : {}), arguments: args },
      },
    ],
  };
}

describe("openai completions stream", () => {
  it.each(["delta", "message"] as const)(
    "keeps Groq parsed %s reasoning in thinking blocks",
    async (field) => {
      const model = makeCompletionsModel({
        provider: "groq",
        id: "qwen/qwen3.6-27b",
        baseUrl: "https://api.groq.com/openai/v1",
      });
      const { output, events, run } = streamFixture(model);
      await run([
        {
          ...makeCompletionsChunk({}, "stop"),
          choices: [
            {
              index: 0,
              [field]: { role: "assistant", reasoning: "Multiply 17 by 23.", content: "391" },
              finish_reason: "stop",
            },
          ],
        },
      ]);
      expect(output.content).toEqual([
        { type: "thinking", thinking: "Multiply 17 by 23.", thinkingSignature: "reasoning" },
        { type: "text", text: "391" },
      ]);
      expect(
        events.filter((event) => event.type === "thinking_delta").map((event) => event.delta),
      ).toEqual(["Multiply 17 by 23."]);
      expect(collectVisibleText(output)).toBe("391");
    },
  );

  it.each([false, true])(
    "publishes cumulative tool input before execution (direct=%s)",
    async (direct) => {
      const model = makeCompletionsModel();
      const output = createAssistantOutput(model);
      const snapshots: unknown[] = [];
      await processCompletionsStream(
        streamChunks([
          makeCompletionsChunk(toolDelta('{"content":"first', "write", "write-progress", 0)),
          makeCompletionsChunk(toolDelta('{"newText":"second', "edit", "edit-progress", 1)),
          makeCompletionsChunk({ tool_calls: [{ index: 0, function: { arguments: ' line"}' } }] }),
          makeCompletionsChunk({ tool_calls: [{ index: 1, function: { arguments: ' line"}' } }] }),
          makeCompletionsChunk({}, "tool_calls"),
        ]),
        output,
        model,
        {
          push: (event) => {
            if (event.type === "toolcall_delta") {
              snapshots.push(structuredClone(event.partial.content[event.contentIndex]));
            }
          },
        },
        direct ? { mode: "direct", beforeContentBlock() {} } : undefined,
      );
      expect(snapshots).toEqual([
        expect.objectContaining({ id: "write-progress", partialJson: '{"content":"first' }),
        expect.objectContaining({ id: "edit-progress", partialJson: '{"newText":"second' }),
        expect.objectContaining({ id: "write-progress", partialJson: '{"content":"first line"}' }),
        expect.objectContaining({ id: "edit-progress", partialJson: '{"newText":"second line"}' }),
      ]);
      expect(output.content).toEqual([
        expectedToolCall("write-progress", "write", { content: "first line" }),
        expectedToolCall("edit-progress", "edit", { newText: "second line" }),
      ]);
    },
  );

  it.each([
    ["length", ["<thi", "nk>unfinished reasoning"], ""],
    ["length", ["Answer. ", "<reasoning>unfinished\n\nreasoning"], "Answer. "],
    ["content_filter", ["<thinking>unfinished reasoning"], ""],
    ["stop", ["<thi", "nk>Recovered answer."], "Recovered answer."],
    ["stop", ["Use <think> in prose"], "Use <think> in prose"],
    ["length", ["<think>hidden</think>", "Answer."], "Answer."],
    ["length", ["Use `<think>` in code. <thi"], "Use `<think>` in code. <thi"],
    ["length", ["Answer </think> remains visible."], "Answer </think> remains visible."],
  ] as const)("finalizes content-only tags on %s: %j", async (finishReason, content, expected) => {
    const { output, events, run } = streamFixture();

    await run(
      [
        ...content.map((text) => makeCompletionsChunk({ content: text })),
        makeCompletionsChunk({}, finishReason),
      ],
      { emitReasoning: false },
    );

    expect(collectVisibleText(output)).toBe(expected);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe(expected);
    expect(output.stopReason).toBe(finishReason === "content_filter" ? "error" : finishReason);
  });

  it.each(["abort", "error"] as const)("does not recover unfinished tags after %s", async (end) => {
    const model = makeCompletionsModel();
    const output = createAssistantOutput(model);
    const abort = new AbortController();
    const events: CapturedStreamEvent[] = [];
    async function* interruptedStream() {
      yield makeCompletionsChunk({ content: "Answer. <think>unfinished reasoning" });
      if (end === "abort") {
        abort.abort();
      } else {
        throw new Error("Provider disconnected");
      }
    }

    await expect(
      processCompletionsStream(
        interruptedStream(),
        output,
        model,
        { push: (event) => events.push(event) },
        { signal: abort.signal, emitReasoning: false },
      ),
    ).rejects.toThrow(end === "abort" ? "Request was aborted" : "Provider disconnected");
    expect(collectVisibleText(output)).toBe("Answer. ");
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ).toEqual(["Answer. "]);
  });

  it("partitions inline reasoning tags out of OpenAI-compatible visible text", async () => {
    const { output, events, run } = streamFixture(miniMax);

    await run([
      makeCompletionsChunk({ content: "Before <thi" }),
      makeCompletionsChunk({
        content: "nk>private reasoning</think> after",
        reasoning_content: "private reasoning",
      }),
      makeCompletionsChunk({}, "stop" as const),
    ]);

    const visibleText = collectVisibleText(output);
    const thinkingText = output.content
      .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");

    expect(visibleText).toBe("Before  after");
    expect(visibleText).not.toContain("private reasoning");
    expect(thinkingText).toBe("private reasoning");
    expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(1);
  });

  it("drops mirrored reasoning when disabled without recovering hidden reasoning tags", async () => {
    const { output, events, run } = streamFixture(miniMax);

    await run(
      [
        makeCompletionsChunk({ content: "<think>private reasoning" }),
        makeCompletionsChunk({ reasoning_content: "private reasoning" }, "stop" as const),
      ],
      { emitReasoning: false },
    );

    expect(collectVisibleText(output)).toBe("");
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
    expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
  });

  it("strips content-only closed reasoning tags in strict replies", async () => {
    const text = "Before <think>private reasoning</think> after";
    const model = createDeepSeekCompletionsModel();
    const { output, run } = streamFixture(model);

    await run(
      [
        makeCompletionsChunk({ content: text.slice(0, 4) }),
        makeCompletionsChunk({ content: text.slice(4) }, "stop"),
      ],
      { strictReasoningTags: true, emitReasoning: false },
    );

    expect(collectVisibleText(output)).toBe("Before  after");
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it.each([
    {
      name: "keeps streamed tool call arguments intact when reasoning_details repeats",
      model: {
        id: "openrouter/qwen/qwen3-235b-a22b",
        name: "Qwen3 235B A22B",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
          reasoning_details: [
            { type: "reasoning.text", text: "Need a tool." },
            { type: "reasoning.text", text: " Let me analyze." },
            { type: "text", text: "Do not leak this by default." },
          ],
          ...toolDelta('{"query":', "lookup", "call_1"),
        }),
        makeCompletionsChunk({
          reasoning_details: [{ type: "reasoning.text", text: " Still thinking." }],
          ...toolDelta('"qwen3"}', undefined, "call_1"),
        }),
        makeCompletionsChunk({}, "tool_calls"),
      ],
      expectedFirst: expectedThinking("Need a tool. Let me analyze."),
      expectedSecond: expectedToolCall("call_1", "lookup", { query: "qwen3" }),
      expectedThird: expectedThinking(" Still thinking."),
    },
    {
      name: "surfaces visible OpenRouter response text from reasoning_details without dropping tools",
      model: routerMiniMax,
      chunks: [
        makeCompletionsChunk({
          reasoning_details: [
            { type: "reasoning.text", text: "Need to look something up." },
            { type: "response.output_text", text: "Working on it." },
          ],
          ...toolDelta('{"query":"weather"}', "lookup", "call_1"),
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ],
      expectedFirst: expectedThinking("Need to look something up."),
      expectedSecond: { type: "text", text: "Working on it." },
      expectedThird: expectedToolCall("call_1", "lookup", { query: "weather" }),
    },
  ])(
    "$name",
    async ({ model: modelOverrides, chunks, expectedFirst, expectedSecond, expectedThird }) => {
      const model = makeCompletionsModel(modelOverrides);
      const { output, run } = streamFixture(model);

      await run(chunks);

      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toHaveLength(3);
      expectRecordFields(output.content[0], expectedFirst);
      expectRecordFields(output.content[1], expectedSecond);
      expectRecordFields(output.content[2], expectedThird);
    },
  );

  it("preserves unphased text across resumed reasoning_details", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/qwen/qwen3-235b-a22b",
      name: "Qwen3 235B A22B",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const { output, run } = streamFixture(model);

    await run([
      makeCompletionsChunk({
        reasoning_details: [{ type: "reasoning.text", text: "First thought." }],
      }),
      makeCompletionsChunk({ content: "Interim." }),
      makeCompletionsChunk({
        reasoning_details: [{ type: "reasoning.text", text: "Second thought." }],
      }),
      makeCompletionsChunk({ content: "Final." }),
      makeCompletionsChunk({}, "stop"),
    ]);

    expect(output.content).toEqual([
      expectedThinking("First thought."),
      { type: "text", text: "Interim." },
      expectedThinking("Second thought."),
      { type: "text", text: "Final." },
    ]);
  });

  it.each([
    {
      name: "fails fast when post-tool-call buffering grows beyond the safety cap",
      makeChunks: () => [
        makeCompletionsChunk(toolDelta('{"query":', "lookup", "call_1")),
        makeCompletionsChunk({ content: "x".repeat(300_000) }),
      ],
      expectedError: "Exceeded post-tool-call delta buffer limit",
    },
    {
      name: "fails fast when streaming tool-call arguments grow beyond the safety cap",
      makeChunks: () => {
        const oversizedArgs = `"${"x".repeat(300_000)}"}`;
        return [makeCompletionsChunk(toolDelta(`{${oversizedArgs}`, "lookup", "call_1"))];
      },
      expectedError: "Exceeded tool-call argument buffer limit",
    },
  ])("$name", async ({ makeChunks, expectedError }) => {
    const { run } = streamFixture(routerMiniMax);
    await expect(run(makeChunks())).rejects.toThrow(expectedError);
  });

  it("keeps a streaming tool call intact when visible reasoning text arrives between chunks", async () => {
    const { output, run } = streamFixture(routerMiniMax);

    await run([
      makeCompletionsChunk(toolDelta('{"query":', "lookup", "call_1")),
      makeCompletionsChunk({
        reasoning_details: [{ type: "response.output_text", text: "Working on it." }],
      }),
      makeCompletionsChunk(toolDelta('"weather"}', undefined, "call_1")),
      makeCompletionsChunk({}, "tool_calls" as const),
    ]);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(2);
    expectRecordFields(
      output.content[0],
      expectedToolCall("call_1", "lookup", { query: "weather" }),
    );
    expectRecordFields(output.content[1], { type: "text", text: "Working on it." });
  });
});

function usageChunk(completionTokens: number, reasoningTokens?: number) {
  return makeCompletionsChunk({}, null, {
    choices: [],
    usage: {
      prompt_tokens: 8,
      completion_tokens: completionTokens,
      total_tokens: 8 + completionTokens,
      ...(reasoningTokens === undefined
        ? {}
        : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
    },
  });
}
async function runChunks(chunks: readonly unknown[], model = makeCompletionsModel()) {
  const { output, events, run } = streamFixture(model);
  await run(chunks);
  return { output, events };
}

describe("openai completions stream", () => {
  it.each(["reasoning before text", "reasoning after text"] as const)(
    "handles %s usage chunks",
    async (kind) => {
      const before = kind === "reasoning before text";
      const text = makeCompletionsChunk(
        { role: "assistant", content: "Hi" },
        before ? "stop" : null,
      );
      const usage = usageChunk(before ? 23 : 25, 23);
      const { output, events } = await runChunks(
        before ? [usage, text] : [text, usage],
        makeCompletionsModel({
          id: "google/gemini-2.5-flash",
          provider: "vertex-ai",
          baseUrl: "http://127.0.0.1:8787/v1beta1/projects/test/locations/us/endpoints/openapi",
        }),
      );
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
      processCompletionsStream(mockStream(), output, model, stream, { signal: abort.signal }),
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
        toolDelta('{"path":"example.txt"}', "read", "call_aborted", 0),
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

describe("OpenAI-compatible provider processing timing", () => {
  it.each([false, true])(
    "preserves final timing in both transports (direct=%s)",
    async (direct) => {
      const { output, run } = streamFixture();
      const previousDiagnostic = { type: "previous", timestamp: 1 };
      output.diagnostics = [previousDiagnostic];
      await run(
        [
          makeCompletionsChunk({ content: "ok" }, null, {
            timings: { prompt_ms: 100, predicted_ms: 200 },
          }),
          makeCompletionsChunk({}, "stop", { timings: { prompt_ms: 3, predicted_ms: 5 } }),
          { ...usageChunk(2), timings: { prompt_ms: 1.25, predicted_ms: 2.5 } },
        ],
        direct ? { mode: "direct", beforeContentBlock() {} } : undefined,
      );
      expect(output.diagnostics).toEqual([
        previousDiagnostic,
        { type: "provider_timing", timestamp: expect.any(Number), details: { processingMs: 3.75 } },
      ]);
    },
  );

  it.each([
    undefined,
    { prompt_ms: 1 },
    { predicted_ms: 1 },
    { prompt_ms: -1, predicted_ms: 1 },
    { prompt_ms: "1", predicted_ms: 1 },
    { prompt_ms: Number.NaN, predicted_ms: 1 },
    { prompt_ms: 1, predicted_ms: Number.POSITIVE_INFINITY },
    { prompt_ms: Number.MAX_VALUE, predicted_ms: Number.MAX_VALUE },
  ])("omits missing, partial, or invalid final timing: %j", async (timings) => {
    const { output } = await runChunks([
      makeCompletionsChunk({ content: "ok" }, null, { timings: { prompt_ms: 1, predicted_ms: 2 } }),
      makeCompletionsChunk({}, "stop", { timings }),
    ]);
    expect(output.diagnostics).toBeUndefined();
  });

  it.each([false, true])(
    "does not publish timing after cancellation (direct=%s)",
    async (direct) => {
      const model = makeCompletionsModel();
      const output = createAssistantOutput(model);
      const abort = new AbortController();
      async function* interrupted() {
        yield makeCompletionsChunk({ content: "ok" }, "stop", {
          timings: { prompt_ms: 1, predicted_ms: 2 },
        });
        abort.abort();
        yield usageChunk(2);
      }
      await expect(
        processCompletionsStream(
          interrupted(),
          output,
          model,
          { push() {} },
          direct
            ? { signal: abort.signal, mode: "direct", beforeContentBlock() {} }
            : { signal: abort.signal },
        ),
      ).rejects.toThrow("Request was aborted");
      expect(output.diagnostics).toBeUndefined();
    },
  );
});
