import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitMessageStartAndEndForAssistantText,
  emitToolRun,
  emitAssistantTextDelta,
  extractAgentEventPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type BlockReply = NonNullable<Parameters<typeof createSubscribedSessionHarness>[0]["onBlockReply"]>;

it("preserves an empty authoritative final after a late block end", async () => {
  const onAgentEvent = vi.fn();
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "run",
    onAgentEvent,
  });
  onTestFinished(() => subscription.unsubscribe());
  const assistantPayloads = () =>
    extractAgentEventPayloads(
      onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant"),
    );
  const block = (text: string, index: number) =>
    createOpenAiResponsesTextBlock({ text, id: `answer-${index}`, phase: "final_answer" });
  const firstBlock = "First block still being revised.";
  const lastBlock = "Second block still being revised.";
  const partial = {
    ...createOpenAiResponsesPartial({
      text: firstBlock,
      id: "answer-0",
      signaturePhase: "final_answer",
    }),
    content: [block(firstBlock, 0), block(lastBlock, 1)],
  };

  emitMessageStartAndEndForAssistantText({ emit, text: "Before tool." });
  emitToolRun({
    emit,
    toolName: "read",
    toolCallId: "read-1",
    args: { path: "notes.txt" },
    isError: false,
    result: { content: [{ type: "text", text: "Read complete." }] },
  });
  await subscription.waitForPendingEvents();

  emit({ type: "message_start", message: { role: "assistant" } });
  for (const [contentIndex, delta] of [firstBlock, lastBlock].entries()) {
    const message = { ...partial, content: partial.content.slice(0, contentIndex + 1) };
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex, delta, partial: message },
    });
  }
  const finalMessage = { ...partial, content: [block("", 0)] };
  emit({ type: "message_end", message: finalMessage });
  await subscription.waitForPendingEvents();
  emit({ type: "agent_end", messages: [finalMessage] });
  await subscription.waitForPendingEvents();

  const finalizedPayloads = assistantPayloads();
  const secondItemId = expectDefined(finalizedPayloads[1], "second message preview").itemId;
  expect(secondItemId).toEqual(expect.stringMatching(/[\s\S]/));
  expect(finalizedPayloads).toMatchObject([
    { text: "Before tool.", itemId: expect.stringMatching(/[\s\S]/) },
    { text: firstBlock, itemId: secondItemId },
    { text: `${firstBlock}\n${lastBlock}`, itemId: secondItemId },
    { text: "", itemId: secondItemId },
  ]);
  expect(secondItemId).not.toBe(finalizedPayloads[0]?.itemId);

  emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "text_end",
      contentIndex: 1,
      content: lastBlock,
      partial,
    },
  });
  await subscription.waitForPendingEvents();
  expect(assistantPayloads()).toEqual(finalizedPayloads);
  const latestByMessage = new Map(
    assistantPayloads().map((payload) => [payload.itemId, payload.text]),
  );
  expect([...latestByMessage.values()]).toEqual(["Before tool.", ""]);
});

type FlushStep = {
  chunks?: string[];
  phase?: "commentary" | "final_answer";
  final?: string;
  beforeFlush?: string[];
  expected: string[];
};
type FlushCase = [name: string, steps: FlushStep[], chunked?: boolean];

it.each<FlushCase>([
  [
    "commentary followed by a final item",
    [
      { chunks: ["Working..."], phase: "commentary", expected: [] },
      { chunks: ["Final answer"], phase: "final_answer", expected: ["Final answer"] },
    ],
  ],
  ["empty buffer", [{ expected: [] }]],
  [
    "hidden-tag context across flushes",
    [
      { chunks: ["Before ", "<think> reasoning without close"], expected: ["Before"] },
      { chunks: ["secret continuation"], expected: ["Before"] },
    ],
  ],
  [
    "orphan reasoning close retracting the flushed prefix",
    [
      { chunks: ["private chain"], expected: ["private chain"] },
      { chunks: ["</mm:think>Visible answer"], expected: ["Visible answer"] },
    ],
  ],
  [
    "live chunks reconciled after an earlier flush",
    [
      { chunks: ["Hello world. "], expected: ["Hello world."] },
      {
        chunks: ["Next sentence. "],
        beforeFlush: ["Hello world.", "Next sentence."],
        expected: ["Hello world. Next sentence."],
      },
    ],
    true,
  ],
  [
    "authoritative empty final",
    [
      { chunks: ["Hello"], expected: ["Hello"] },
      { final: "", expected: [] },
    ],
  ],
])("flushPartialAssistantText preserves %s", (_name, steps, chunked) => {
  const onBlockReply = vi.fn<BlockReply>();
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "run",
    ...(chunked
      ? {
          onBlockReply,
          blockReplyChunking: { minChars: 8, maxChars: 200, breakPreference: "sentence" },
        }
      : {}),
  });
  onTestFinished(() => subscription.unsubscribe());
  if (steps.some((step) => step.chunks !== undefined)) {
    emit({ type: "message_start", message: { role: "assistant" } });
  }
  for (const { chunks, phase, final, beforeFlush, expected } of steps) {
    for (const delta of chunks ?? []) {
      if (phase) {
        emit(
          createOpenAiResponsesTextEvent({
            type: "text_delta",
            text: delta,
            delta,
            id: `item-${phase}`,
            signaturePhase: phase,
            partialPhase: phase,
          }),
        );
      } else {
        emitAssistantTextDelta({ emit, delta });
      }
    }
    if (final !== undefined) {
      emit({ type: "message_end", message: textAssistant(final) });
    } else {
      if (beforeFlush) {
        expect(subscription.assistantTexts).toEqual(beforeFlush);
      }
      subscription.flushPartialAssistantText();
    }
    expect(subscription.assistantTexts).toEqual(expected);
  }
  if (chunked) {
    expect(onBlockReply).toHaveBeenCalled();
  }
});
