import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitMessageStartAndEndForAssistantText,
  emitToolRun,
  extractAgentEventPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("subscribeEmbeddedAgentSession deferred progress", () => {
  it.each([
    { finalText: "First.\nDone.", deferred: true },
    { finalText: "", deferred: false },
  ])(
    "subscribeEmbeddedAgentSession supersedes deferred progress and preserves authoritative final %j after a late block end",
    async ({ finalText, deferred }) => {
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run",
        onAgentEvent,
        onBeforeTerminalDelivery: deferred ? () => undefined : undefined,
      });
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

      try {
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
        const finalMessage = { ...partial, content: finalText.split("\n").map(block) };
        emit({ type: "message_end", message: finalMessage });
        await subscription.waitForPendingEvents();
        if (deferred) {
          expect(assistantPayloads()).toEqual([]);
        }
        emit({ type: "agent_end", messages: [finalMessage] });
        await subscription.waitForPendingEvents();

        const finalizedPayloads = assistantPayloads();
        expect(finalizedPayloads).toHaveLength(deferred ? 3 : 4);
        const firstMessage = deferred ? undefined : finalizedPayloads[0];
        if (!deferred) {
          expect(firstMessage).toMatchObject({ text: "Before tool.", itemId: expect.any(String) });
          expect(firstMessage?.itemId).not.toBe("");
        }
        const streamed = finalizedPayloads.slice(deferred ? 0 : 1, -1);
        expect(streamed.map((payload) => payload.text)).toEqual([
          firstBlock,
          `${firstBlock}\n${lastBlock}`,
        ]);
        const secondItemId = expectDefined(streamed[0], "second message preview").itemId;
        expect(secondItemId).toEqual(expect.any(String));
        expect(secondItemId).not.toBe("");
        if (firstMessage) {
          expect(secondItemId).not.toBe(firstMessage.itemId);
        }
        expect(streamed.every((payload) => payload.itemId === secondItemId)).toBe(true);
        expect(finalizedPayloads.at(-1)).toMatchObject({ text: finalText, itemId: secondItemId });

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
        expect([...latestByMessage.values()]).toEqual(
          deferred ? [finalText] : ["Before tool.", finalText],
        );
      } finally {
        subscription.unsubscribe();
      }
    },
  );
});
