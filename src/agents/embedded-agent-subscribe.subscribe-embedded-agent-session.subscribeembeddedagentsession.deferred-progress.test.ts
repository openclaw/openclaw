import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
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

describe("flushPartialAssistantText", () => {
  it.each([false, true])(
    "keeps commentary out of timeout flush (final item: %s)",
    (hasFinalAnswer) => {
      const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
      emit({ type: "message_start", message: { role: "assistant" } });
      emit(
        createOpenAiResponsesTextEvent({
          type: "text_delta",
          text: "Working...",
          delta: "Working...",
          id: "item-commentary",
          signaturePhase: "commentary",
          partialPhase: "commentary",
        }),
      );
      if (hasFinalAnswer) {
        emit(
          createOpenAiResponsesTextEvent({
            type: "text_delta",
            text: "Final answer",
            delta: "Final answer",
            id: "item-final",
            signaturePhase: "final_answer",
            partialPhase: "final_answer",
          }),
        );
      }
      subscription.flushPartialAssistantText();
      expect(subscription.assistantTexts).toEqual(hasFinalAnswer ? ["Final answer"] : []);
    },
  );

  it.each([
    {
      name: "strips downgraded tool call text",
      chunks: ["Visible answer", " [Tool Call: some_fn]"],
      expected: ["Visible answer"],
    },
    {
      name: "is a no-op when deltaBuffer is empty",
      chunks: [],
      expected: [],
    },
    {
      name: "preserves visible prefix before unclosed final tag on flush",
      enforceFinalTag: true,
      chunks: ["Before ", "<final> content without close"],
      expected: [" content without close"],
    },
  ])("$name", ({ chunks, enforceFinalTag, expected }) => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      enforceFinalTag,
    });
    if (chunks.length > 0) {
      emit({ type: "message_start", message: { role: "assistant" } });
    }
    for (const chunk of chunks) {
      emitAssistantTextDelta({ emit, delta: chunk });
    }
    subscription.flushPartialAssistantText();
    expect(subscription.assistantTexts).toEqual(expected);
  });

  it.each([
    {
      name: "retains hidden-tag context across flushes so a queued suffix inside an unclosed think tag never leaks",
      chunks: ["Before ", "<think> reasoning without close"],
      firstExpected: ["Before"],
      suffix: "secret continuation",
      expected: ["Before"],
    },
    {
      name: "replaces a flushed entry when a queued orphan reasoning close retracts the prefix",
      chunks: ["private chain"],
      firstExpected: ["private chain"],
      suffix: "</mm:think>Visible answer",
      expected: ["Visible answer"],
    },
  ])("$name", ({ chunks, firstExpected, suffix, expected }) => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const chunk of chunks) {
      emitAssistantTextDelta({ emit, delta: chunk });
    }
    subscription.flushPartialAssistantText();
    if (firstExpected) {
      expect(subscription.assistantTexts).toEqual(firstExpected);
    }
    if (suffix) {
      emitAssistantTextDelta({ emit, delta: suffix });
    }
    subscription.flushPartialAssistantText();
    expect(subscription.assistantTexts).toEqual(expected);
  });

  it("reconciles live block chunks without duplication after an earlier flush", () => {
    const onBlockReply = vi.fn<BlockReply>();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyChunking: {
        minChars: 8,
        maxChars: 200,
        breakPreference: "sentence",
      },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello world. " });
    subscription.flushPartialAssistantText();
    expect(subscription.assistantTexts).toEqual(["Hello world."]);
    emitAssistantTextDelta({ emit, delta: "Next sentence. " });
    expect(subscription.assistantTexts).toEqual(["Hello world.", "Next sentence."]);
    subscription.flushPartialAssistantText();
    expect(subscription.assistantTexts).toEqual(["Hello world. Next sentence."]);
    expect(onBlockReply).toHaveBeenCalled();
  });

  it.each(["Hello world", ""])(
    "replaces flushed partial text with authoritative final %j when message_end arrives",
    (finalText) => {
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run",
      });

      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextDelta({ emit, delta: "Hello" });
      subscription.flushPartialAssistantText();
      expect(subscription.assistantTexts).toEqual(["Hello"]);
      emit({
        type: "message_end",
        message: textAssistant(finalText),
      });

      expect(subscription.assistantTexts).toEqual(finalText ? [finalText] : []);
    },
  );
});
