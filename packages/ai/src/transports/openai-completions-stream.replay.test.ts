import { createServer } from "node:http";
import type { StreamFn, StreamFunction } from "@openclaw/llm-core";
import { afterAll, describe, expect, it } from "vitest";
import { resetDiagnosticRunActivityForTest } from "../../../../src/logging/diagnostic-run-activity.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

const TEXT_A = "The harbor lights flicker at dusk. ";
const TEXT_B = "Ferries cross until midnight. ";
const TEXT_C = "Then the tide takes over. ";

type ReplayChunk = ReturnType<typeof makeCompletionsChunk>;

type ReplayCase = {
  chunks: ReplayChunk[];
  compat?: Record<string, unknown>;
  expectedText: string;
};

type CompletionsStreamCreator =
  | StreamFn
  | StreamFunction<"openai-completions", OpenAICompletionsOptions>;

async function runStreamBlocks(
  createStream: CompletionsStreamCreator,
  caseInput: ReplayCase,
): Promise<string[]> {
  const server = createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      for (const chunk of caseInput.chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback server address");
    }
    const model = makeCompletionsModel({
      provider: "compatible-proxy",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      ...(caseInput.compat ? { compat: caseInput.compat } : {}),
    });
    // The managed transport factory satisfies StreamFn, whose return may be the
    // stream itself rather than a promise; resolve before awaiting uniformly.
    const stream = await Promise.resolve(
      createStream(
        model,
        { messages: [{ role: "user", content: "Stream the text.", timestamp: 1 }] },
        { apiKey: "synthetic-test-key" },
      ),
    );
    const result = await stream.result();
    return result.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function runStream(
  createStream: CompletionsStreamCreator,
  caseInput: ReplayCase,
): Promise<string> {
  const blocks = await runStreamBlocks(createStream, caseInput);
  return blocks.join("");
}

const replayChunks = (): ReplayChunk[] => [
  makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
  makeCompletionsChunk({ content: TEXT_B }),
  // Provider quirk under test: one frame restating everything so far.
  makeCompletionsChunk({ content: TEXT_A + TEXT_B }),
  makeCompletionsChunk({ content: TEXT_C }),
  makeCompletionsChunk({}, "stop"),
];

const toolCallChunk = (): ReplayChunk =>
  makeCompletionsChunk({
    tool_calls: [
      {
        index: 0,
        id: "call_replay_probe",
        type: "function",
        function: { name: "probe_tool", arguments: "{}" },
      },
    ],
  });

const replayAfterToolCallChunks = (): ReplayChunk[] => [
  makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
  toolCallChunk(),
  makeCompletionsChunk({ content: TEXT_B }),
  makeCompletionsChunk({ content: TEXT_A + TEXT_B }),
  makeCompletionsChunk({ content: TEXT_C }),
  makeCompletionsChunk({}, "stop"),
];

describe.each([
  { name: "direct", createStream: streamOpenAICompletions },
  { name: "managed", createStream: createOpenAICompletionsTransportStreamFn() },
])("$name cumulative text delta replays", ({ createStream }) => {
  afterAll(() => {
    resetDiagnosticRunActivityForTest();
  });

  it("drops a bare delta that restates the whole accumulated text when enabled", async () => {
    const text = await runStream(createStream, {
      chunks: replayChunks(),
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: TEXT_A + TEXT_B + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_B + TEXT_C);
  });

  it("keeps the historical append behavior when disabled", async () => {
    const text = await runStream(createStream, {
      chunks: replayChunks(),
      expectedText: TEXT_A + TEXT_B + (TEXT_A + TEXT_B) + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_B + (TEXT_A + TEXT_B) + TEXT_C);
  });

  it("preserves short exact repeats while enabled", async () => {
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: "Ha" }),
        makeCompletionsChunk({ content: "Ha" }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: "HaHa",
    });
    expect(text).toBe("HaHa");
  });

  it("preserves long repeats that do not restate the whole message while enabled", async () => {
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A + TEXT_B }),
        // Repeats the previous delta verbatim, but not the whole message text.
        makeCompletionsChunk({ content: TEXT_B }),
        makeCompletionsChunk({ content: TEXT_C }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: TEXT_A + TEXT_B + TEXT_B + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_B + TEXT_B + TEXT_C);
  });

  it("drops a message-shaped frame equal to the accumulated text while enabled", async () => {
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({ content: TEXT_B }),
        // No `delta` key: the message field is the only content carrier.
        makeCompletionsChunk(null, null, {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: TEXT_A + TEXT_B },
              finish_reason: null,
            },
          ],
        }),
        makeCompletionsChunk({ content: TEXT_C }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: TEXT_A + TEXT_B + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_B + TEXT_C);
  });

  it("appends a message-shaped frame equal to the accumulated text when disabled", async () => {
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({ content: TEXT_B }),
        makeCompletionsChunk(null, null, {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: TEXT_A + TEXT_B },
              finish_reason: null,
            },
          ],
        }),
        makeCompletionsChunk({ content: TEXT_C }),
        makeCompletionsChunk({}, "stop"),
      ],
      expectedText: TEXT_A + TEXT_B + (TEXT_A + TEXT_B) + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_B + (TEXT_A + TEXT_B) + TEXT_C);
  });

  it("continues appending ordinary deltas after a dropped replay while enabled", async () => {
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({ content: TEXT_A }),
        makeCompletionsChunk({ content: TEXT_A + TEXT_B }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: TEXT_A + (TEXT_A + TEXT_B),
    });
    expect(text).toBe(TEXT_A + TEXT_A + TEXT_B);
  });

  it("drops a cumulative replay after a tool call when enabled", async () => {
    // On the managed transport, post-tool-call text is buffered until the
    // stream ends, so a ledger that only advances at the append sink compares
    // against a stale prefix and lets the replay double the output.
    const text = await runStream(createStream, {
      chunks: replayAfterToolCallChunks(),
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: TEXT_A + TEXT_B + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_B + TEXT_C);
  });

  it("keeps post-tool-call text that repeats earlier output while enabled", async () => {
    // The repeat opens a new text block (empty checkpoint), so it is not a
    // cumulative replay of the block it belongs to and must keep flowing.
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        toolCallChunk(),
        makeCompletionsChunk({ content: TEXT_A }),
        makeCompletionsChunk({ content: TEXT_C }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: TEXT_A + TEXT_A + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_A + TEXT_C);
  });

  it("keeps the historical append behavior after a tool call when disabled", async () => {
    const text = await runStream(createStream, {
      chunks: replayAfterToolCallChunks(),
      expectedText: TEXT_A + TEXT_B + (TEXT_A + TEXT_B) + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_B + (TEXT_A + TEXT_B) + TEXT_C);
  });

  it("drops a cumulative replay after a visible reasoning detail when enabled", async () => {
    // Visible reasoning details feed the same block through a second path; the
    // ledger must include them or a provider that emits both under-protects.
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({
          reasoning_details: [{ type: "response.output_text", text: TEXT_A }],
        }),
        makeCompletionsChunk({ content: TEXT_B }),
        makeCompletionsChunk({ content: TEXT_A + TEXT_B }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: {
        dropCumulativeTextDeltaReplays: true,
        visibleReasoningDetailTypes: ["response.output_text"],
      },
      expectedText: TEXT_A + TEXT_B,
    });
    expect(text).toBe(TEXT_A + TEXT_B);
  });

  it("drops a visible-text replay after inline reasoning tags when enabled", async () => {
    // The ledger tracks filtered visible text, so a replay of the visible
    // block matches even though the raw frames carried reasoning-tag syntax.
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ content: `${TEXT_A}<think>x</think>${TEXT_B}` }),
        makeCompletionsChunk({ content: TEXT_A + TEXT_B }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: TEXT_A + TEXT_B,
    });
    expect(text).toBe(TEXT_A + TEXT_B);
  });

  it("drops a cumulative replay after a queued post-tool-call reasoning detail when enabled", async () => {
    // Managed transport: post-tool-call reasoning details are queued before
    // their append, and the admission must cover them anyway.
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        toolCallChunk(),
        makeCompletionsChunk({
          reasoning_details: [{ type: "response.output_text", text: TEXT_B }],
        }),
        makeCompletionsChunk({ content: TEXT_C }),
        makeCompletionsChunk({ content: TEXT_A + TEXT_B + TEXT_C }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: {
        dropCumulativeTextDeltaReplays: true,
        visibleReasoningDetailTypes: ["response.output_text"],
      },
      expectedText: TEXT_A + TEXT_B + TEXT_C,
    });
    expect(text).toBe(TEXT_A + TEXT_B + TEXT_C);
  });

  it("keeps a prefix released before an incomplete trailing tag while enabled", async () => {
    // A frame ending in an incomplete tag makes the partitioner release only
    // its prefix; that piece can restate the whole block without the frame
    // being a replay, so it must not be dropped.
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({ content: `${TEXT_A}<` }),
        makeCompletionsChunk({ content: "b>tail" }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: `${TEXT_A}${TEXT_A}<b>tail`,
    });
    expect(text).toBe(`${TEXT_A}${TEXT_A}<b>tail`);
  });

  it("keeps a completed frame whose visible pieces exceed the block while enabled", async () => {
    // A completed parse can return several visible pieces (reasoning tags
    // between them). The comparison unit is the whole frame's visible
    // contribution: the first piece alone restating the block must not drop.
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({ content: `${TEXT_A}<think>x</think>tail` }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: `${TEXT_A}${TEXT_A}tail`,
    });
    expect(text).toBe(`${TEXT_A}${TEXT_A}tail`);
  });

  it("drops a multi-piece frame restating the whole visible block while enabled", async () => {
    // A replay frame may carry reasoning tags; the frame's visible total
    // restates the block, so every visible piece of the frame is dropped.
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A + TEXT_B }),
        makeCompletionsChunk({ content: `${TEXT_A}<think>x</think>${TEXT_B}` }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: TEXT_A + TEXT_B,
    });
    expect(text).toBe(TEXT_A + TEXT_B);
  });

  it("keeps the delivered final answer identical whether the restated run is suppressed", async () => {
    // The structured reasoning part interrupts the open text block, so the
    // interrupted run and the genuine follow-up stay separate blocks.
    // Suppression may only shrink the interrupted block by its duplicate
    // copy; the follow-up block must stay byte-identical.
    const chunks = [
      makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
      makeCompletionsChunk({
        content: [
          { type: "text", text: TEXT_A },
          { type: "thinking", thinking: "Recheck." },
          { type: "text", text: "Additional detail." },
        ],
      }),
      makeCompletionsChunk({}, "stop"),
    ];
    const suppressed = await runStreamBlocks(createStream, {
      chunks,
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: `${TEXT_A}Additional detail.`,
    });
    const appended = await runStreamBlocks(createStream, {
      chunks,
      expectedText: `${TEXT_A}${TEXT_A}Additional detail.`,
    });

    expect(suppressed).toEqual([TEXT_A, "Additional detail."]);
    expect(appended).toEqual([TEXT_A + TEXT_A, "Additional detail."]);
  });

  it("classifies structured content parts of one frame together while enabled", async () => {
    // Array content flattens into separate deltas; the first part alone can
    // restate the block while the frame's total adds genuine text, so the
    // classification must cover the whole frame's parts.
    const text = await runStream(createStream, {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({
          content: [
            { type: "text", text: TEXT_A },
            { type: "text", text: "tail" },
          ],
        }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: { dropCumulativeTextDeltaReplays: true },
      expectedText: `${TEXT_A}${TEXT_A}tail`,
    });
    expect(text).toBe(`${TEXT_A}${TEXT_A}tail`);
  });
});

describe("managed cumulative text delta replays with DSML recovery", () => {
  afterAll(() => {
    resetDiagnosticRunActivityForTest();
  });

  it("keeps a prefix released before an open DSML suppression span", async () => {
    // Consuming the open marker empties the filter buffer while the
    // suppression span stays open (close token set). The pending-state check
    // must include the open span, or the released prefix gets classified as a
    // complete replay and dropped instead of surviving as the incomplete
    // frame's prefix.
    const text = await runStream(createOpenAICompletionsTransportStreamFn(), {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: "Knock knock. " }),
        makeCompletionsChunk({ content: "Knock knock. <|DSML|tool_use_error>" }),
        makeCompletionsChunk({ content: "hidden</|DSML|tool_use_error>tail" }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: {
        dropCumulativeTextDeltaReplays: true,
        thinkingFormat: "deepseek",
      },
      expectedText: "Knock knock. Knock knock. tail",
    });
    expect(text).toBe("Knock knock. Knock knock. tail");
  });

  it("keeps a prefix released while DSML recovery holds a possible token", async () => {
    // A frame ending in a partial DSML tool token makes the recovery stage
    // hold the suffix and release only the prefix; that piece can restate the
    // whole block without the frame being a replay.
    const text = await runStream(createOpenAICompletionsTransportStreamFn(), {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({ content: `${TEXT_A}<|DSML|tool_c` }),
        makeCompletionsChunk({ content: "alls>x</|DSML|tool_calls>tail" }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: {
        dropCumulativeTextDeltaReplays: true,
        thinkingFormat: "deepseek",
      },
      expectedText: `${TEXT_A}${TEXT_A}tail`,
    });
    expect(text).toBe(`${TEXT_A}${TEXT_A}tail`);
  });

  it("keeps a completed frame with a DSML wrapper after the repeated prefix", async () => {
    // The recovery stage returns several entries for one completed frame; the
    // frame's visible total exceeds the block, so the repeated prefix stays.
    const text = await runStream(createOpenAICompletionsTransportStreamFn(), {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({ content: `${TEXT_A}<|DSML|tool_calls>x</|DSML|tool_calls>tail` }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: {
        dropCumulativeTextDeltaReplays: true,
        thinkingFormat: "deepseek",
      },
      expectedText: `${TEXT_A}${TEXT_A}tail`,
    });
    expect(text).toBe(`${TEXT_A}${TEXT_A}tail`);
  });

  it("suppresses a complete replay hidden behind DSML markup while enabled", async () => {
    // The wrapper is filtered away, so the frame's filtered visible total
    // restates the block exactly and the whole frame is suppressed.
    const text = await runStream(createOpenAICompletionsTransportStreamFn(), {
      chunks: [
        makeCompletionsChunk({ role: "assistant", content: TEXT_A }),
        makeCompletionsChunk({ content: `${TEXT_A}<|DSML|tool_calls>x</|DSML|tool_calls>` }),
        makeCompletionsChunk({}, "stop"),
      ],
      compat: {
        dropCumulativeTextDeltaReplays: true,
        thinkingFormat: "deepseek",
      },
      expectedText: TEXT_A,
    });
    expect(text).toBe(TEXT_A);
  });
});

// Ported from openai-completions-stream.reasoning-and-buffering.test.ts after
// upstream removal (low-value test cull, batch d008): these pin the replay
// guard's settle ordering and phase-boundary behavior, including the
// regression that caught flushes emitting after resumed reasoning fields.
describe("reasoning field transitions across replay guard modes", () => {
  it("keeps reasoning transitions between strict-buffered structured text parts", async () => {
    const model = makeCompletionsModel({
      id: "test/reasoning-strict-frame",
      name: "Reasoning Strict Frame",
      provider: "test",
      baseUrl: "https://test.invalid/v1",
      reasoning: true,
      compat: { dropCumulativeTextDeltaReplays: true },
    });
    const output = createAssistantOutput(model);
    const emitted: string[] = [];
    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ reasoning_content: "First." }),
        makeCompletionsChunk({
          content: [
            { type: "text", text: "Interim." },
            { type: "thinking", thinking: "Second." },
            { type: "text", text: "Final." },
          ],
        }),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      {
        push(event) {
          if (event.type === "text_delta" || event.type === "thinking_delta") {
            emitted.push(`${event.type}:${event.delta}`);
          }
        },
      },
      { strictReasoningTags: true },
    );

    expect(emitted).toEqual([
      "thinking_delta:First.",
      "text_delta:Interim.",
      "thinking_delta:Second.",
      "text_delta:Final.",
    ]);
    expect(output.content.map((block) => block.type)).toEqual([
      "thinking",
      "text",
      "thinking",
      "text",
    ]);
  });

  it.each([
    {
      name: "enabled",
      compat: { dropCumulativeTextDeltaReplays: true } as Record<string, unknown>,
    },
    { name: "disabled", compat: undefined },
  ])(
    "orders released text before structured reasoning while tag syntax stays pending with replays $name",
    async ({ compat }) => {
      const model = makeCompletionsModel({
        id: "test/reasoning-pending-syntax-ordering",
        name: "Reasoning Pending Syntax Ordering",
        provider: "test",
        baseUrl: "https://test.invalid/v1",
        reasoning: true,
        ...(compat ? { compat } : {}),
      });
      const output = createAssistantOutput(model);
      const emitted: string[] = [];
      await processCompletionsStream(
        streamChunks([
          makeCompletionsChunk({ reasoning_content: "First." }),
          // The trailing tag syntax stays incomplete, so only the text prefix is released.
          makeCompletionsChunk({ content: "Interim.<think" }),
          makeCompletionsChunk({
            content: [
              { type: "thinking", thinking: "Second." },
              { type: "text", text: "Final." },
            ],
          }),
          makeCompletionsChunk({}, "stop"),
        ]),
        output,
        model,
        {
          push(event) {
            if (event.type === "text_delta" || event.type === "thinking_delta") {
              emitted.push(`${event.type}:${event.delta}`);
            }
          },
        },
        { strictReasoningTags: true },
      );

      expect(emitted).toEqual([
        "thinking_delta:First.",
        "text_delta:Interim.<think",
        "thinking_delta:Second.",
        "text_delta:Final.",
      ]);
      expect(output.content.map((block) => block.type)).toEqual([
        "thinking",
        "text",
        "thinking",
        "text",
      ]);
    },
  );

  it("orders flushed text before resumed reasoning fields with replays enabled", async () => {
    // Strict parsing holds "Interim." across its chunk; the resumed reasoning
    // frame's seal flush releases it into the deferred replay plan. The plan
    // must settle before the reasoning field emits, or Second. streams ahead
    // of Interim. and the two thinking fields merge across the missing text
    // boundary.
    const model = makeCompletionsModel({
      id: "test/replay-deferred-flush-ordering",
      name: "Replay Deferred Flush Ordering",
      provider: "test",
      baseUrl: "https://test.invalid/v1",
      reasoning: true,
      compat: { dropCumulativeTextDeltaReplays: true } as Record<string, unknown>,
    });
    const output = createAssistantOutput(model);
    const emitted: string[] = [];
    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ reasoning_content: "First." }),
        makeCompletionsChunk({ content: "Interim." }),
        makeCompletionsChunk({ reasoning_content: "Second." }),
        makeCompletionsChunk({ content: "Final." }),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      {
        push(event) {
          if (event.type === "text_delta" || event.type === "thinking_delta") {
            emitted.push(`${event.type}:${event.delta}`);
          }
        },
      },
      { strictReasoningTags: true },
    );

    expect(emitted).toEqual([
      "thinking_delta:First.",
      "text_delta:Interim.",
      "thinking_delta:Second.",
      "text_delta:Final.",
    ]);
    expect(output.content.map((block) => block.type)).toEqual([
      "thinking",
      "text",
      "thinking",
      "text",
    ]);
    // The deferred plan must materialize Interim. as its own text block
    // before the resumed reasoning field emits, or the two text blocks merge.
    const textBlocks = output.content
      .filter((block) => block.type === "text")
      .map((block) => block as { text: string });
    expect(textBlocks.map((block) => block.text)).toEqual(["Interim.", "Final."]);
  });
});
