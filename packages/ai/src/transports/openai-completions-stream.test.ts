import { describe, expect, it, vi } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
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
import { parseOpenAICompletionsUsage } from "./openai-transport-shared.js";

function collectVisibleText(output: OpenAICompletionsOutput): string {
  return output.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

describe("openai completions stream", () => {
  it.each([false, true])(
    "publishes cumulative tool input before execution (direct=%s)",
    async (direct) => {
      const model = makeCompletionsModel();
      const output = createAssistantOutput(model);
      const snapshots: unknown[] = [];
      await processCompletionsStream(
        streamChunks([
          makeCompletionsChunk({
            tool_calls: [
              {
                index: 0,
                id: "write-progress",
                type: "function",
                function: { name: "write", arguments: '{"content":"first' },
              },
            ],
          }),
          makeCompletionsChunk({
            tool_calls: [
              {
                index: 1,
                id: "edit-progress",
                type: "function",
                function: { name: "edit", arguments: '{"newText":"second' },
              },
            ],
          }),
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
        direct
          ? { mode: "direct", beforeContentBlock() {}, provisionalCommentaryTags: new Map() }
          : undefined,
      );
      expect(snapshots).toEqual([
        expect.objectContaining({ id: "write-progress", partialJson: '{"content":"first' }),
        expect.objectContaining({ id: "edit-progress", partialJson: '{"newText":"second' }),
        expect.objectContaining({ id: "write-progress", partialJson: '{"content":"first line"}' }),
        expect.objectContaining({ id: "edit-progress", partialJson: '{"newText":"second line"}' }),
      ]);
      expect(output.content).toEqual([
        {
          type: "toolCall",
          id: "write-progress",
          name: "write",
          arguments: { content: "first line" },
        },
        {
          type: "toolCall",
          id: "edit-progress",
          name: "edit",
          arguments: { newText: "second line" },
        },
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
    const model = makeCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await processCompletionsStream(
      streamChunks([
        ...content.map((text) => makeCompletionsChunk({ content: text })),
        makeCompletionsChunk({}, finishReason),
      ]),
      output,
      model,
      { push: (event) => events.push(event) },
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
    const model = makeCompletionsModel({
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      provider: "minimax",
      baseUrl: "https://api.minimax.test/v1",
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content: "Before <thi",
        }),
        makeCompletionsChunk({
          content: "nk>private reasoning</think> after",
          reasoning_content: "private reasoning",
        }),
        makeCompletionsChunk({}, "stop" as const),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
    );

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
    const model = makeCompletionsModel({
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      provider: "minimax",
      baseUrl: "https://api.minimax.test/v1",
    });
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          content: "<think>private reasoning",
        }),
        makeCompletionsChunk(
          {
            reasoning_content: "private reasoning",
          },
          "stop" as const,
        ),
      ]),
      output,
      model,
      { push: (event) => events.push(event as CapturedStreamEvent) },
      { emitReasoning: false },
    );

    expect(collectVisibleText(output)).toBe("");
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
    expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
  });

  it("strips content-only closed reasoning tags in strict replies", async () => {
    const text = "Before <think>private reasoning</think> after";
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ content: text.slice(0, 4) }),
        makeCompletionsChunk({ content: text.slice(4) }, "stop"),
      ]),
      output,
      model,
      { push() {} },
      { strictReasoningTags: true, emitReasoning: false },
    );

    expect(collectVisibleText(output)).toBe("Before  after");
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
  });
});

describe("openai completions stream", () => {
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
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":' },
            },
          ],
        }),
        makeCompletionsChunk({
          reasoning_details: [{ type: "reasoning.text", text: " Still thinking." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { arguments: '"qwen3"}' },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls"),
      ],
      expectedFirst: {
        type: "thinking",
        thinking: "Need a tool. Let me analyze.",
        thinkingSignature: "reasoning_details",
      },
      expectedSecond: {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "qwen3" },
      },
      expectedThird: {
        type: "thinking",
        thinking: " Still thinking.",
        thinkingSignature: "reasoning_details",
      },
    },
    {
      name: "surfaces visible OpenRouter response text from reasoning_details without dropping tools",
      model: {
        id: "openrouter/minimax/minimax-m2.7",
        name: "MiniMax M2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
          reasoning_details: [
            { type: "reasoning.text", text: "Need to look something up." },
            { type: "response.output_text", text: "Working on it." },
          ],
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":"weather"}' },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ],
      expectedFirst: {
        type: "thinking",
        thinking: "Need to look something up.",
        thinkingSignature: "reasoning_details",
      },
      expectedSecond: { type: "text", text: "Working on it." },
      expectedThird: {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "weather" },
      },
    },
  ])(
    "$name",
    async ({ model: modelOverrides, chunks, expectedFirst, expectedSecond, expectedThird }) => {
      const model = makeCompletionsModel(modelOverrides);
      const output = createAssistantOutput(model);

      await processCompletionsStream(streamChunks(chunks), output, model, {
        push() {},
      });

      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toHaveLength(3);
      expectRecordFields(output.content[0], expectedFirst);
      expectRecordFields(output.content[1], expectedSecond);
      expectRecordFields(output.content[2], expectedThird);
    },
  );

  it("phases text interrupted by resumed reasoning_details", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/qwen/qwen3-235b-a22b",
      name: "Qwen3 235B A22B",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({
          reasoning_details: [{ type: "reasoning.text", text: "First thought." }],
        }),
        makeCompletionsChunk({ content: "Interim." }),
        makeCompletionsChunk({
          reasoning_details: [{ type: "reasoning.text", text: "Second thought." }],
        }),
        makeCompletionsChunk({ content: "Final." }),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content).toEqual([
      {
        type: "thinking",
        thinking: "First thought.",
        thinkingSignature: "reasoning_details",
      },
      {
        type: "text",
        text: "Interim.",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
        ),
      },
      {
        type: "thinking",
        thinking: "Second thought.",
        thinkingSignature: "reasoning_details",
      },
      {
        type: "text",
        text: "Final.",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"final-answer-0-[0-9a-f]{24}","phase":"final_answer"\}$/u,
        ),
      },
    ]);
  });

  it.each([
    {
      name: "fails fast when post-tool-call buffering grows beyond the safety cap",
      makeChunks: () => [
        makeCompletionsChunk({
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":' },
            },
          ],
        }),
        makeCompletionsChunk({ content: "x".repeat(300_000) }),
      ],
      expectedError: "Exceeded post-tool-call delta buffer limit",
    },
    {
      name: "fails fast when streaming tool-call arguments grow beyond the safety cap",
      makeChunks: () => {
        const oversizedArgs = `"${"x".repeat(300_000)}"}`;
        return [
          makeCompletionsChunk({
            tool_calls: [
              {
                id: "call_1",
                type: "function" as const,
                function: { name: "lookup", arguments: `{${oversizedArgs}` },
              },
            ],
          }),
        ];
      },
      expectedError: "Exceeded tool-call argument buffer limit",
    },
  ])("$name", async ({ makeChunks, expectedError }) => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const output = createAssistantOutput(model);

    await expect(
      processCompletionsStream(streamChunks(makeChunks()), output, model, {
        push() {},
      }),
    ).rejects.toThrow(expectedError);
  });
});

describe("openai completions stream", () => {
  it("normalizes structured completions content blocks without stringifying objects (#78846)", async () => {
    const model = makeCompletionsModel({
      id: "mistral-small-latest",
      name: "Mistral Small",
      provider: "mistral",
      baseUrl: "https://api.mistral.ai/v1",
    });

    const output = createAssistantOutput(model);

    const stream: { push(event: unknown): void } = { push() {} };
    const mockChunks = [
      makeCompletionsChunk({
        content: [
          { type: "thinking", thinking: [{ type: "text", text: "Need to think." }] },
          { type: "text", content: "Visible answer." },
        ],
      }),
      makeCompletionsChunk({}, "stop"),
    ] as const;

    await processCompletionsStream(streamChunks(mockChunks), output, model, stream);

    expect(output.content).toEqual([
      { type: "thinking", thinking: "Need to think." },
      { type: "text", text: "Visible answer." },
    ]);
  });

  it.each([
    {
      name: "keeps a streaming tool call intact when visible reasoning text arrives between chunks",
      model: {
        id: "openrouter/minimax/minimax-m2.7",
        name: "MiniMax M2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":' },
            },
          ],
        }),
        makeCompletionsChunk({
          reasoning_details: [{ type: "response.output_text", text: "Working on it." }],
        }),
        makeCompletionsChunk({
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { arguments: '"weather"}' },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ],
      expectedFirst: {
        type: "toolCall",
        id: "call_1",
        name: "lookup",
        arguments: { query: "weather" },
      },
      expectedSecond: { type: "text", text: "Working on it." },
    },
  ])("$name", async ({ model: modelOverrides, chunks, expectedFirst, expectedSecond }) => {
    const model = makeCompletionsModel(modelOverrides);
    const output = createAssistantOutput(model);

    await processCompletionsStream(streamChunks(chunks), output, model, {
      push() {},
    });

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], expectedFirst);
    expectRecordFields(output.content[1], expectedSecond);
  });
});

describe("openai completions stream", () => {
  it("accumulates arguments for parallel tool calls with split indices", async () => {
    const model = makeCompletionsModel({
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-code",
      baseUrl: "https://api.moonshot.cn",
    });

    const output = createAssistantOutput(model);

    const mockChunks = [
      makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_0",
            type: "function",
            function: { name: "exec", arguments: "" },
          },
          {
            index: 1,
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: "" },
          },
        ],
      }),
      makeCompletionsChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }],
      }),
      makeCompletionsChunk(
        {
          tool_calls: [{ index: 1, function: { arguments: '{"path":"/tmp"}' } }],
        },
        "tool_calls" as const,
      ),
    ] as const;

    await processCompletionsStream(streamChunks(mockChunks), output, model, {
      push() {},
    });

    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], {
      type: "toolCall",
      id: "call_0",
      name: "exec",
      arguments: { command: "ls" },
    });
    expectRecordFields(output.content[1], {
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: { path: "/tmp" },
    });
  });
});

const pricedModel = makeCompletionsModel({
  id: "gpt-5",
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
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
  it("clamps uncached prompt usage at zero", () => {
    const usage = parseOpenAICompletionsUsage(
      {
        prompt_tokens: 2,
        completion_tokens: 5,
        total_tokens: 7,
        prompt_tokens_details: { cached_tokens: 4 },
      },
      pricedModel,
    );
    expectRecordFields(usage, {
      input: 0,
      output: 5,
      cacheRead: 4,
      totalTokens: 9,
      contextUsage: { state: "unavailable" },
    });
  });

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
