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
  const partial = createOpenAiResponsesPartial({
    text: firstBlock,
    id: "answer-0",
    signaturePhase: "final_answer",
  });
  partial.content.push(block(lastBlock, 1));
  const update = (message: unknown, assistantMessageEvent: unknown) =>
    emit({ type: "message_update", message, assistantMessageEvent });

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
    update(message, { type: "text_delta", contentIndex, delta, partial: message });
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

  update(partial, {
    type: "text_end",
    contentIndex: 1,
    content: lastBlock,
    partial,
  });
  await subscription.waitForPendingEvents();
  expect(assistantPayloads()).toEqual(finalizedPayloads);
  const latestByMessage = new Map(
    assistantPayloads().map((payload) => [payload.itemId, payload.text]),
  );
  expect([...latestByMessage.values()]).toEqual(["Before tool.", ""]);
});

// Arrays are streamed chunks; strings are authoritative message-end text.
type FlushStep = [
  input: string[] | string | undefined,
  expected: string[],
  phase?: "commentary" | "final_answer",
  beforeFlush?: string[],
];
type FlushCase = [name: string, steps: FlushStep[], chunked?: boolean];

it.each<FlushCase>([
  [
    "commentary followed by a final item",
    [
      [["Working..."], [], "commentary"],
      [["Final answer"], ["Final answer"], "final_answer"],
    ],
  ],
  ["empty buffer", [[undefined, []]]],
  [
    "hidden-tag context across flushes",
    [
      [["Before ", "<think> reasoning without close"], ["Before"]],
      [["secret continuation"], ["Before"]],
    ],
  ],
  [
    "orphan reasoning close retracting the flushed prefix",
    [
      [["private chain"], ["private chain"]],
      [["</mm:think>Visible answer"], ["Visible answer"]],
    ],
  ],
  [
    "live chunks reconciled after an earlier flush",
    [
      [["Hello world. "], ["Hello world."]],
      [
        ["Next sentence. "],
        ["Hello world. Next sentence."],
        undefined,
        ["Hello world.", "Next sentence."],
      ],
    ],
    true,
  ],
  [
    "authoritative empty final",
    [
      [["Hello"], ["Hello"]],
      ["", []],
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
  if (steps.some(([input]) => Array.isArray(input))) {
    emit({ type: "message_start", message: { role: "assistant" } });
  }
  for (const [input, expected, phase, beforeFlush] of steps) {
    if (typeof input === "string") {
      emit({ type: "message_end", message: textAssistant(input) });
    } else {
      for (const delta of input ?? []) {
        if (phase) {
          emit(
            createOpenAiResponsesTextEvent({
              type: "text_delta",
              text: delta,
              id: `item-${phase}`,
              signaturePhase: phase,
              partialPhase: phase,
            }),
          );
        } else {
          emitAssistantTextDelta({ emit, delta });
        }
      }
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
