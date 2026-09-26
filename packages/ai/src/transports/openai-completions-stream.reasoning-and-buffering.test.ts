import type { AssistantMessageEvent } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  expectRecordFields,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

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
          reasoning_details: [{ type: "reasoning.text", text: "Need a tool." }],
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
        thinking: "Need a tool.",
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

  it.each([
    {
      name: "does not surface ambiguous reasoning_details text without explicit compat opt-in",
      model: {
        id: "openrouter/x-ai/grok-4",
        name: "Grok 4",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk({
          reasoning_details: [
            { type: "reasoning.text", text: "Internal thought." },
            { type: "text", text: "Do not leak this by default." },
          ],
        }),
        makeCompletionsChunk({}, "stop" as const),
      ],
      expected: {
        type: "thinking",
        thinking: "Internal thought.",
        thinkingSignature: "reasoning_details",
      },
    },
    {
      name: "does not duplicate fallback reasoning fields when reasoning_details already provided thinking",
      model: {
        id: "openrouter/minimax/minimax-m2.7",
        name: "MiniMax M2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      chunks: [
        makeCompletionsChunk(
          {
            reasoning_details: [{ type: "reasoning.text", text: "Primary reasoning." }],
            reasoning: "Duplicate fallback reasoning.",
          },
          "stop" as const,
        ),
      ],
      expected: {
        type: "thinking",
        thinking: "Primary reasoning.",
        thinkingSignature: "reasoning_details",
      },
    },
  ])("$name", async ({ model: modelOverrides, chunks, expected }) => {
    const model = makeCompletionsModel(modelOverrides);
    const output = createAssistantOutput(model);

    await processCompletionsStream(streamChunks(chunks), output, model, {
      push() {},
    });

    expect(output.content).toHaveLength(1);
    expectRecordFields(output.content[0], expected);
  });

  it("preserves explicitly visible reasoning_details without phase reclassification", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const output = createAssistantOutput(model);

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      makeCompletionsChunk(
        {
          reasoning_details: [
            { type: "response.output_text", text: "Visible first." },
            { type: "reasoning.text", text: " Hidden second." },
            { type: "response.text", text: " Visible third." },
          ],
        },
        "stop",
      ),
    ] as const;

    await processCompletionsStream(streamChunks(mockChunks), output, model, stream);

    expect(output.content).toHaveLength(3);
    expectRecordFields(output.content[0], { type: "text", text: "Visible first." });
    expectRecordFields(output.content[1], {
      type: "thinking",
      thinking: " Hidden second.",
      thinkingSignature: "reasoning_details",
    });
    expectRecordFields(output.content[2], { type: "text", text: " Visible third." });
  });

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

  it("keeps fallback thinking when reasoning_details only carries visible text", async () => {
    const model = makeCompletionsModel({
      id: "openrouter/minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const output = createAssistantOutput(model);

    const stream: { push(event: unknown): void } = { push() {} };

    const mockChunks = [
      makeCompletionsChunk(
        {
          reasoning_details: [{ type: "response.output_text", text: "Visible answer." }],
          reasoning: "Hidden fallback reasoning.",
        },
        "stop",
      ),
    ] as const;

    await processCompletionsStream(streamChunks(mockChunks), output, model, stream);

    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], { type: "text", text: "Visible answer." });
    expectRecordFields(output.content[1], {
      type: "thinking",
      thinking: "Hidden fallback reasoning.",
      thinkingSignature: "reasoning",
    });
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

describe("openai completions stream: MiMo inline reasoning leak on tool-call turns (#156803)", () => {
  function visibleTextOf(output: ReturnType<typeof createAssistantOutput>) {
    return output.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  function toolCallsOf(
    output: ReturnType<typeof createAssistantOutput>,
  ): Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> {
    return output.content.filter(
      (
        block,
      ): block is {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      } => block.type === "toolCall",
    );
  }

  async function runLeakyStream(
    chunks: readonly unknown[] | AsyncIterable<never>,
    strict: boolean | "on-flush",
    events?: AssistantMessageEvent[],
  ) {
    const model = makeCompletionsModel({
      id: "mimo-v2.6-pro",
      name: "MiMo V2.6 Pro",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });
    const output = createAssistantOutput(model);
    // Accept a pre-built chunk iterable too: one test snapshots event counts
    // per pulled chunk via a local generator wrapper.
    const chunkStream: AsyncIterable<never> =
      Symbol.asyncIterator in chunks
        ? chunks
        : streamChunks(chunks as Parameters<typeof streamChunks>[0]);
    await processCompletionsStream(
      chunkStream,
      output,
      model,
      {
        push(event) {
          events?.push(event);
        },
      },
      { strictReasoningTags: strict },
    );
    return output;
  }

  function makeLeakyToolCallChunks() {
    // vLLM mimo parser streams a literal opener and absorbs the closer server-side.
    return [
      makeCompletionsChunk({ content: "<think>secret reasoning step" }),
      makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function" as const,
            function: { name: "lookup", arguments: '{"query":"weather"}' },
          },
        ],
      }),
      makeCompletionsChunk({}, "tool_calls" as const),
    ];
  }

  it("hides unclosed inline reasoning from visible text when strictReasoningTags is enabled (strict-on-flush)", async () => {
    const model = makeCompletionsModel({
      id: "mimo-v2.6-pro",
      name: "MiMo V2.6 Pro",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks(makeLeakyToolCallChunks()),
      output,
      model,
      { push() {} },
      { strictReasoningTags: "on-flush" },
    );

    const visibleText = output.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(visibleText).toBe("");
    expect(visibleText).not.toContain("secret reasoning step");

    const toolCalls = toolCallsOf(output);
    expect(output.stopReason).toBe("toolUse");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe("lookup");
    expect(toolCalls[0]?.arguments).toEqual({ query: "weather" });
  });

  it("reproduces the leak as visible text when strictReasoningTags is disabled", async () => {
    const model = makeCompletionsModel({
      id: "mimo-v2.6-pro",
      name: "MiMo V2.6 Pro",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });
    const output = createAssistantOutput(model);

    await processCompletionsStream(
      streamChunks(makeLeakyToolCallChunks()),
      output,
      model,
      { push() {} },
      { strictReasoningTags: false },
    );

    // Non-strict mode recovers the unclosed pending buffer as visible TEXT at
    // the tool-call boundary — this is the leak reported in issue #156803.
    const visibleText = output.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(visibleText).toContain("secret reasoning step");

    const toolCalls = toolCallsOf(output);
    expect(toolCalls).toHaveLength(1);
  });

  it("hides a reasoning opener split across streamed chunks when strict-on-flush is enabled", async () => {
    // Packet boundaries may cut the opener itself ("<thi" | "nk>"); the tag
    // probe must still route the whole block away from visible text.
    const output = await runLeakyStream(
      [
        makeCompletionsChunk({ content: "<thi" }),
        makeCompletionsChunk({ content: "nk>secret reasoning step" }),
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ],
      "on-flush",
    );

    expect(visibleTextOf(output)).toBe("");
    expect(toolCallsOf(output)).toHaveLength(1);
  });

  it("hides inline reasoning when content and tool calls share one chunk", async () => {
    const output = await runLeakyStream(
      [
        makeCompletionsChunk({
          content: "<think>secret reasoning step",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ],
      "on-flush",
    );

    expect(visibleTextOf(output)).toBe("");
    expect(toolCallsOf(output)).toHaveLength(1);
  });

  it("drops leaked reasoning instead of promoting it into the thinking lane", async () => {
    const output = await runLeakyStream(makeLeakyToolCallChunks(), "on-flush");

    // Strict-on-flush classifies the unclosed block as reasoning and drops it
    // at flush; it must never resurface as a thinking block on the visible output.
    expect(output.content.some((block) => block.type === "thinking")).toBe(false);
    expect(visibleTextOf(output)).toBe("");
  });

  it("keeps streaming ordinary visible text incrementally when strict-on-flush is enabled", async () => {
    // Strict-on-flush must not over-hide: ordinary answers keep streaming as
    // incremental text events instead of one blob buffered until flush.
    const events: AssistantMessageEvent[] = [];
    const inputs = [
      makeCompletionsChunk({ content: "All good.\n\n" }),
      makeCompletionsChunk({ content: "Nothing here is hidden." }),
      makeCompletionsChunk({}, "stop" as const),
    ];
    // Local generator wrapper: records the event count right after each chunk
    // is pulled, so the test can prove text reached the consumer before the
    // final chunk was consumed (full strict would hold everything until flush).
    const eventsAfterChunk: number[] = [];
    async function* trackedChunks() {
      for (const chunk of inputs) {
        yield chunk as never;
        eventsAfterChunk.push(events.length);
      }
    }

    const output = await runLeakyStream(trackedChunks(), "on-flush", events);

    expect(visibleTextOf(output)).toContain("All good.");
    expect(visibleTextOf(output)).toContain("Nothing here is hidden.");
    expect(output.stopReason).toBe("stop");

    // Per-chunk streaming: at least two distinct text deltas, not one merged
    // blob (full strict would merge them into a single flush release).
    const textDeltaPayloads = events.flatMap((event) =>
      event.type === "text_delta" ? [event.delta] : [],
    );
    expect(textDeltaPayloads.length).toBeGreaterThanOrEqual(2);
    expect(new Set(textDeltaPayloads).size).toBeGreaterThanOrEqual(2);

    // Incremental delivery: visible text already existed before the last
    // (finish-reason) chunk was pulled.
    expect(eventsAfterChunk).toHaveLength(inputs.length);
    const eventsBeforeFinalChunk = eventsAfterChunk[eventsAfterChunk.length - 2] ?? 0;
    expect(
      events.slice(0, eventsBeforeFinalChunk).some((event) => event.type === "text_delta"),
    ).toBe(true);
  });

  it("keeps post-tool-call answers streaming after a strict-on-flush boundary", async () => {
    const events: AssistantMessageEvent[] = [];
    const output = await runLeakyStream(
      [
        makeCompletionsChunk({ content: "<thinking>leaked reasoning" }),
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        }),
        makeCompletionsChunk({ content: "Real " }),
        makeCompletionsChunk({ content: "answer." }),
        makeCompletionsChunk({}, "stop" as const),
      ],
      "on-flush",
      events,
    );

    // The tool-call delta flushes the partitioner, so the unclosed inline
    // reasoning stays hidden; the answer after the boundary streams as usual.
    expect(visibleTextOf(output)).not.toContain("leaked");
    expect(visibleTextOf(output)).toContain("Real answer.");
    expect(output.stopReason).toBe("stop");
    // Terminal finalization drops the provisional tool call because the stream
    // finished with "stop" and produced visible text; the boundary itself stays
    // observable on the event stream below.
    expect(toolCallsOf(output)).toHaveLength(0);

    // Order check: the answer's text delta is emitted after the tool-call events.
    const lastToolCallEventIndex = events.findLastIndex(
      (event) =>
        event.type === "toolcall_start" ||
        event.type === "toolcall_delta" ||
        event.type === "toolcall_end",
    );
    const answerDeltaIndexes = events.flatMap((event, index) =>
      event.type === "text_delta" && event.delta.includes("answer") ? [index] : [],
    );
    expect(lastToolCallEventIndex).toBeGreaterThanOrEqual(0);
    expect(answerDeltaIndexes.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...answerDeltaIndexes)).toBeGreaterThan(lastToolCallEventIndex);
  });

  it("documents the strict-on-flush boundary: a closer arriving after a flush is prose", async () => {
    const output = await runLeakyStream(
      [
        makeCompletionsChunk({ content: "<thinking>leaked reasoning" }),
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function" as const,
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        }),
        makeCompletionsChunk({ content: "more reasoning</thinking>Final answer." }),
        makeCompletionsChunk({}, "stop" as const),
      ],
      "on-flush",
    );

    // Accepted trade-off: after an intermediate flush the partitioner starts
    // fresh, so a late closer is indistinguishable from prose and the text
    // stays visible — matching non-strict visible semantics. The pre-boundary
    // unclosed block is still hidden.
    expect(visibleTextOf(output)).not.toContain("leaked");
    expect(visibleTextOf(output)).toBe("more reasoning</thinking>Final answer.");
    expect(output.stopReason).toBe("stop");
    // Same terminal rule as above: a "stop" stream with visible text confirms no
    // tool call, so only the text survives into the final message.
    expect(toolCallsOf(output)).toHaveLength(0);
  });
});
