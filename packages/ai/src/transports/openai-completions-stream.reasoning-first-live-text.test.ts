import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

type StreamEvent = { type: string; delta?: string };

function collectEvents() {
  const events: StreamEvent[] = [];
  return { events, push: (event: StreamEvent) => void events.push(event) };
}

function textDeltas(events: readonly StreamEvent[]): string[] {
  return events.filter((event) => event.type === "text_delta").map((event) => event.delta ?? "");
}

describe("openai completions stream: reasoning before text streams live", () => {
  const model = makeCompletionsModel({
    id: "qwen38-flash-next",
    name: "Qwen 3.8 Flash Next",
    provider: "vllm",
    baseUrl: "http://10.0.0.30:8000/v1",
  });

  it("emits each text delta as it arrives when native reasoning precedes all text", async () => {
    const output = createAssistantOutput(model);
    const sink = collectEvents();

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ reasoning: "Plan the" }),
        makeCompletionsChunk({ reasoning: " answer." }),
        makeCompletionsChunk({ content: "# Guide\n\n" }),
        makeCompletionsChunk({ content: "Run `systemctl --user daemon-reload` first.\n\n" }),
        makeCompletionsChunk({ content: "```bash\nnpm start\n```\n" }),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      sink,
    );

    // Text streams as it arrives (the partitioner may re-split around code
    // spans); nothing waits for the terminal.
    const deltas = textDeltas(sink.events);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas.join("")).toBe(
      "# Guide\n\nRun `systemctl --user daemon-reload` first.\n\n```bash\nnpm start\n```\n",
    );
    expect(output.openclawDelivery?.textPhaseRequiresTerminal).toBeUndefined();
    expect(output.content).toEqual([
      { type: "thinking", thinking: "Plan the answer.", thinkingSignature: "reasoning" },
      {
        type: "text",
        text: "# Guide\n\nRun `systemctl --user daemon-reload` first.\n\n```bash\nnpm start\n```\n",
      },
    ]);
  });

  it("keeps live text flowing while reasoning and text interleave inside one chunk", async () => {
    const output = createAssistantOutput(model);
    const sink = collectEvents();

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ reasoning: "Think." }),
        makeCompletionsChunk({ reasoning: " Done.", content: "Answer" }),
        makeCompletionsChunk({ content: " text.\n\n" }),
        makeCompletionsChunk({ content: "More" }),
        makeCompletionsChunk({ content: " here.\n\n" }),
        makeCompletionsChunk({ content: "End." }),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      sink,
    );

    // Text that shares a chunk with reasoning goes through the tag-aware path
    // and is released at the next block boundary rather than at the terminal.
    const deltas = textDeltas(sink.events);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.join("")).toBe("Answer text.\n\nMore here.\n\nEnd.");
    expect(output.openclawDelivery?.textPhaseRequiresTerminal).toBeUndefined();
  });

  it("still defers text once native reasoning resumes after visible text", async () => {
    const output = createAssistantOutput(model);
    const sink = collectEvents();

    await processCompletionsStream(
      streamChunks([
        makeCompletionsChunk({ reasoning: "First thought." }),
        makeCompletionsChunk({ content: "Interim." }),
        makeCompletionsChunk({ reasoning: "Second thought." }),
        makeCompletionsChunk({ content: "Fin" }),
        makeCompletionsChunk({ content: "al." }),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      sink,
    );

    // The interim text streamed before anything made its phase ambiguous; the
    // text after the resumed reasoning waits for the terminal and lands whole.
    expect(textDeltas(sink.events)).toEqual(["Interim.", "Final."]);
    expect(output.openclawDelivery?.textPhaseRequiresTerminal).toBe(true);
    expect(output.content).toEqual([
      { type: "thinking", thinking: "First thought.", thinkingSignature: "reasoning" },
      {
        type: "text",
        text: "Interim.",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
        ),
      },
      { type: "thinking", thinking: "Second thought.", thinkingSignature: "reasoning" },
      {
        type: "text",
        text: "Final.",
        textSignature: expect.stringMatching(
          /^\{"v":1,"id":"final-answer-0-[0-9a-f]{24}","phase":"final_answer"\}$/u,
        ),
      },
    ]);
  });
});
