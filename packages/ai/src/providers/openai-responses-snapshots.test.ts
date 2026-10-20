import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import type { AssistantMessage, AssistantMessageEvent } from "../types.js";
import { createResponsesAssistantOutput } from "./openai-responses-shared.js";
import { makeProviderModel } from "./provider-model.test-support.js";

const nativeOpenAIModel = makeProviderModel("openai-responses", "openai", "gpt-5.5", {
  name: "GPT-5.5",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 200000,
});

function captureResponses() {
  const output: AssistantMessage = {
    ...createResponsesAssistantOutput(nativeOpenAIModel),
    timestamp: 0,
  };
  const events: AssistantMessageEvent[] = [];
  const signatures: Array<[string, string | undefined]> = [];
  const sink = {
    push(event: AssistantMessageEvent) {
      events.push(event);
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        const block = event.partial?.content[event.contentIndex];
        signatures.push([event.type, block?.type === "text" ? block.textSignature : undefined]);
      }
    },
  };
  return {
    output,
    events,
    signatures: (exclude: string) =>
      signatures.filter(([type]) => type !== exclude).map(([, value]) => value),
    run: (input: readonly unknown[]) =>
      processResponsesStream(responseEvents(input), output, sink, nativeOpenAIModel),
  };
}
function signature(id: string) {
  return JSON.stringify({ v: 1, id, phase: "final_answer" });
}
function eventTrace(events: AssistantMessageEvent[]) {
  return events
    .map((event) => `${event.type}@${"contentIndex" in event ? event.contentIndex : "-"}`)
    .join(" ");
}
function textDelta(delta: string) {
  return { type: "response.output_text.delta", delta };
}
const emptyPart = { type: "response.content_part.added", part: { type: "output_text", text: "" } };

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
    const { output, events, signatures, run } = captureResponses();

    const snapshot1 = `${"Self-attention computes 🙂 ".repeat(128)}.`;
    const snapshot2 = `${snapshot1} Q/K/V projections`;
    const snapshot3 = `${snapshot2} for each token.`;

    await run([
      messageAdded("msg_1"),
      emptyPart,
      textDelta(snapshot1),
      messageDone("msg_1", snapshot1),
      messageAdded("msg_2"),
      textDelta(""),
      ...Array.from({ length: Math.ceil(snapshot2.length / 16) }, (_, index) =>
        textDelta(snapshot2.slice(index * 16, (index + 1) * 16)),
      ),
      textDelta(""),
      messageDone("msg_2", snapshot2),
      messageAdded("msg_3"),
      messageDone("msg_3", snapshot3),
      completed,
    ]);

    expect(output.content).toEqual([textBlock("msg_3", snapshot3)]);
    expect(eventTrace(events)).toBe("text_start@0 text_delta@0 text_end@0 text_end@0 text_end@0");
    expect(
      events.filter((event) => event.type === "text_end").map((event) => event.content),
    ).toEqual([snapshot1, snapshot2, snapshot3]);
    expect(signatures("text_delta")).toEqual([
      signature("msg_1"),
      signature("msg_1"),
      signature("msg_2"),
      signature("msg_3"),
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
      const { output, events, run } = captureResponses();
      await run([
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
        textDelta(b.slice(0, 4)),
        textDelta(b.slice(4)),
        messageDone("msg_2", b),
        completed,
      ]);

      expect(output.content).toEqual([
        textBlock("msg_1", a, phase),
        ...(reasoning
          ? [
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: JSON.stringify({ id: "rs_1", type: "reasoning", summary: [] }),
              },
            ]
          : []),
        textBlock("msg_2", b),
      ]);
      expect(eventTrace(events)).toBe(
        "text_start@0 text_end@0 " +
          (reasoning
            ? "thinking_start@1 thinking_end@1 text_start@2 text_delta@2 text_delta@2 text_end@2"
            : "text_start@1 text_end@1"),
      );
    },
  );

  it.each([
    ["first delta", "Hello.", "", "Good", "bye"],
    ["prior boundary", `${"prefix".repeat(512)}X`, "prefix".repeat(512), "Y tail", " after"],
  ])(
    "streams a deferred message live when it diverges at the %s",
    async (_label, prior, prefix, divergentDelta, remainingDelta) => {
      const { output, events, signatures, run } = captureResponses();

      await run([
        messageAdded("msg_1"),
        messageDone("msg_1", prior),
        messageAdded("msg_2"),
        emptyPart,
        textDelta(prefix),
        textDelta(divergentDelta),
        textDelta(remainingDelta),
        messageDone("msg_2", prefix + divergentDelta + remainingDelta),
        completed,
      ]);

      expect(output.content).toEqual([
        textBlock("msg_1", prior),
        textBlock("msg_2", prefix + divergentDelta + remainingDelta),
      ]);
      expect(eventTrace(events)).toBe(
        "text_start@0 text_end@0 text_start@1 text_delta@1 text_delta@1 text_end@1",
      );
      expect(
        events.filter((event) => event.type === "text_delta").map((event) => event.delta),
      ).toEqual([prefix + divergentDelta, remainingDelta]);
      expect(signatures("text_end")).toEqual([
        signature("msg_1"),
        signature("msg_2"),
        undefined,
        undefined,
      ]);
    },
  );
});
