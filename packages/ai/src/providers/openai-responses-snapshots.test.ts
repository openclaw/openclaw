import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { createResponsesAssistantOutput } from "./openai-responses-shared.js";

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function createAssistantOutput(): AssistantMessage {
  return { ...createResponsesAssistantOutput(nativeOpenAIModel), timestamp: 0 };
}

function messageAdded(id: string, phase = "final_answer") {
  return { type: "response.output_item.added", item: { type: "message", id, phase } };
}

function messageDone(id: string, text: string, phase = "final_answer") {
  return {
    type: "response.output_item.done",
    item: { type: "message", id, phase, content: [{ type: "output_text", text }] },
  };
}

function textBlock(id: string, text: string, phase = "final_answer") {
  return { type: "text", text, textSignature: JSON.stringify({ v: 1, id, phase }) };
}

const completed = { type: "response.completed", response: { id: "resp_1", status: "completed" } };

async function* responseEvents(events: readonly unknown[]) {
  yield* events;
}

describe("Responses cumulative message snapshots", () => {
  it("collapses cumulative message snapshot items into one text block (#91959)", async () => {
    const output = createAssistantOutput();
    const stream = new AssistantMessageEventStream();
    const events: AssistantMessageEvent[] = [];
    const textBlockSignatures: Array<[string, number, string | undefined]> = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "text_start" || event.type === "text_end") {
          const block = event.partial.content[event.contentIndex];
          textBlockSignatures.push([
            event.type,
            event.contentIndex,
            block?.type === "text" ? block.textSignature : undefined,
          ]);
        }
      }
    })();

    const snapshot1 = `${"Self-attention computes 🙂 ".repeat(128)}.`;
    const snapshot2 = `${snapshot1} Q/K/V projections`;
    const snapshot3 = `${snapshot2} for each token.`;

    await processResponsesStream(
      responseEvents([
        messageAdded("msg_1"),
        { type: "response.content_part.added", part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", delta: snapshot1 },
        messageDone("msg_1", snapshot1),
        messageAdded("msg_2"),
        { type: "response.output_text.delta", delta: "" },
        ...Array.from({ length: Math.ceil(snapshot2.length / 16) }, (_, index) => ({
          type: "response.output_text.delta",
          delta: snapshot2.slice(index * 16, (index + 1) * 16),
        })),
        { type: "response.output_text.delta", delta: "" },
        messageDone("msg_2", snapshot2),
        messageAdded("msg_3"),
        messageDone("msg_3", snapshot3),
        completed,
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );
    stream.end();
    await collect;

    expect(output.content).toEqual([textBlock("msg_3", snapshot3)]);
    // Balanced lifecycle: exactly one text_start, every event on index 0, and
    // each collapsed snapshot re-ends the same block with its grown content.
    expect(
      events.map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined]),
    ).toEqual([
      ["text_start", 0],
      ["text_delta", 0],
      ["text_end", 0],
      ["text_end", 0],
      ["text_end", 0],
    ]);
    expect(
      events.filter((event) => event.type === "text_end").map((event) => event.content),
    ).toEqual([snapshot1, snapshot2, snapshot3]);
    expect(textBlockSignatures).toEqual([
      ["text_start", 0, JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" })],
      ["text_end", 0, JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" })],
      ["text_end", 0, JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" })],
      ["text_end", 0, JSON.stringify({ v: 1, id: "msg_3", phase: "final_answer" })],
    ]);
  });

  it.each([
    ["identical", "Hello world.", "Hello world.", "final_answer", false],
    ["shrinking", "Step one. Step two.", "Step one.", "final_answer", false],
    ["different phase", "Done", "Done.", "commentary", false],
    ["intervening reasoning", "Step one.", "Step one. Step two.", "final_answer", true],
  ] as const)(
    "keeps %s message items as distinct blocks",
    async (_label, a, b, phase, reasoning) => {
      const output = createAssistantOutput();
      const stream = new AssistantMessageEventStream();
      const events: AssistantMessageEvent[] = [];
      const collect = (async () => {
        for await (const event of stream) {
          events.push(event);
        }
      })();
      await processResponsesStream(
        responseEvents([
          messageAdded("msg_1", phase),
          messageDone("msg_1", a, phase),
          ...(reasoning
            ? [
                { type: "response.output_item.added", item: { type: "reasoning" } },
                {
                  type: "response.output_item.done",
                  item: { type: "reasoning", id: "rs_1", summary: [] },
                },
              ]
            : []),
          messageAdded("msg_2"),
          { type: "response.output_text.delta", delta: b.slice(0, 4) },
          { type: "response.output_text.delta", delta: b.slice(4) },
          messageDone("msg_2", b),
          completed,
        ]),
        output,
        stream,
        nativeOpenAIModel,
      );
      stream.end();
      await collect;

      expect(output.content).toEqual([
        textBlock("msg_1", a, phase),
        ...(reasoning
          ? [
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
              },
            ]
          : []),
        textBlock("msg_2", b),
      ]);
      expect(
        events.map((event) => [
          event.type,
          "contentIndex" in event ? event.contentIndex : undefined,
        ]),
      ).toEqual([
        ["text_start", 0],
        ["text_end", 0],
        ...(reasoning
          ? [
              ["thinking_start", 1],
              ["thinking_end", 1],
              ["text_start", 2],
              ["text_delta", 2],
              ["text_delta", 2],
              ["text_end", 2],
            ]
          : [
              ["text_start", 1],
              ["text_end", 1],
            ]),
      ]);
    },
  );

  it.each([
    ["first delta", "Hello.", "", "Good", "bye"],
    ["prior boundary", `${"prefix".repeat(512)}X`, "prefix".repeat(512), "Y tail", " after"],
  ])(
    "streams a deferred message live when it diverges at the %s",
    async (_label, prior, prefix, divergentDelta, remainingDelta) => {
      const output = createAssistantOutput();
      const events: AssistantMessageEvent[] = [];
      const liveTextBlockSignatures: Array<[string, number, string | undefined]> = [];
      const stream = {
        push(event: AssistantMessageEvent) {
          events.push(event);
          if (event.type === "text_start" || event.type === "text_delta") {
            const block = event.partial?.content[event.contentIndex];
            liveTextBlockSignatures.push([
              event.type,
              event.contentIndex,
              block?.type === "text" ? block.textSignature : undefined,
            ]);
          }
        },
      };

      await processResponsesStream(
        responseEvents([
          messageAdded("msg_1"),
          messageDone("msg_1", prior),
          messageAdded("msg_2"),
          { type: "response.content_part.added", part: { type: "output_text", text: "" } },
          { type: "response.output_text.delta", delta: prefix },
          { type: "response.output_text.delta", delta: divergentDelta },
          { type: "response.output_text.delta", delta: remainingDelta },
          messageDone("msg_2", prefix + divergentDelta + remainingDelta),
          completed,
        ]),
        output,
        stream,
        nativeOpenAIModel,
      );

      expect(output.content).toEqual([
        textBlock("msg_1", prior),
        textBlock("msg_2", prefix + divergentDelta + remainingDelta),
      ]);
      // Replay the entire withheld prefix at divergence, then stream subsequent deltas live.
      expect(
        events.map((event) => [
          event.type,
          "contentIndex" in event ? event.contentIndex : undefined,
          event.type === "text_delta" ? event.delta : null,
        ]),
      ).toEqual([
        ["text_start", 0, null],
        ["text_end", 0, null],
        ["text_start", 1, null],
        ["text_delta", 1, prefix + divergentDelta],
        ["text_delta", 1, remainingDelta],
        ["text_end", 1, null],
      ]);
      expect(liveTextBlockSignatures).toEqual([
        ["text_start", 0, JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" })],
        ["text_start", 1, JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" })],
        ["text_delta", 1, undefined],
        ["text_delta", 1, undefined],
      ]);
    },
  );
});
