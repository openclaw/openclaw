// Text-end block reply tests cover streamed block delivery, message_end
// de-duplication, and OpenAI Responses phase handling.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
  type OpenAiResponsesTextEventPhase,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

type TextEndBlockReplyHarness = ReturnType<typeof createTextEndBlockReplyHarness>;
type OnBlockReplyMock = ReturnType<typeof vi.fn>;
type BlockReplyPayload = { text?: string; replyToCurrent?: boolean; replyToTag?: boolean };
type PartialReplyPayload = {
  text?: string;
  delta?: string;
  replace?: boolean;
  mediaUrls?: string[];
};

function emitOpenAiResponsesTextEvent(params: {
  emit: TextEndBlockReplyHarness["emit"];
  type: "text_delta" | "text_end";
  text: string;
  delta?: string;
  id: string;
  signaturePhase?: OpenAiResponsesTextEventPhase;
  partialPhase?: OpenAiResponsesTextEventPhase;
}) {
  // Responses events carry item ids and phase signatures; tests preserve those
  // fields so commentary/final routing matches provider payloads.
  const { emit, ...eventParams } = params;
  emit(createOpenAiResponsesTextEvent(eventParams));
}

function emitOpenAiResponsesTextDeltaAndEnd(params: {
  emit: TextEndBlockReplyHarness["emit"];
  text: string;
  delta?: string;
  id: string;
  phase?: OpenAiResponsesTextEventPhase;
}) {
  const { phase, ...eventParams } = params;
  emitOpenAiResponsesTextEvent({
    ...eventParams,
    type: "text_delta",
    signaturePhase: phase,
    partialPhase: phase,
  });
  emitOpenAiResponsesTextEvent({
    ...eventParams,
    type: "text_end",
    delta: undefined,
    signaturePhase: phase,
    partialPhase: phase,
  });
}

function emitOpenAiResponsesFinalMessageEnd(params: {
  emit: TextEndBlockReplyHarness["emit"];
  commentaryText: string;
  finalText: string;
}) {
  params.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        createOpenAiResponsesTextBlock({
          text: params.commentaryText,
          id: "item_commentary",
          phase: "commentary",
        }),
        createOpenAiResponsesTextBlock({
          text: params.finalText,
          id: "item_final",
          phase: "final_answer",
        }),
      ],
    } as AssistantMessage,
  });
}

async function emitSuppressedCommentary(params: {
  emit: TextEndBlockReplyHarness["emit"];
  text: string;
}) {
  // Commentary can stream before final_answer; this helper proves suppressed
  // commentary does not count as a delivered block.
  params.emit({ type: "message_start", message: { role: "assistant" } });
  emitOpenAiResponsesTextDeltaAndEnd({
    emit: params.emit,
    text: params.text,
    id: "item_commentary",
    phase: "commentary",
  });
  await Promise.resolve();
}

function expectSingleBlockReplyText(params: {
  onBlockReply: OnBlockReplyMock;
  subscription: TextEndBlockReplyHarness["subscription"];
  text: string;
}) {
  expect(params.onBlockReply).toHaveBeenCalledTimes(1);
  expect(requireBlockReplyPayload(params.onBlockReply).text).toBe(params.text);
  expect(params.subscription.assistantTexts).toEqual([params.text]);
}

function requireBlockReplyPayload(onBlockReply: OnBlockReplyMock): BlockReplyPayload {
  // Most cases expect exactly one user-visible block reply.
  const call = onBlockReply.mock.calls[0];
  if (!call) {
    throw new Error("expected first block reply call");
  }
  const payload = call[0];
  if (!payload || typeof payload !== "object") {
    throw new Error("expected first block reply payload");
  }
  return payload as BlockReplyPayload;
}

describe("subscribeEmbeddedAgentSession", () => {
  it("replaces unsupported SMS receipt claims before partial streaming replies", async () => {
    const onPartialReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onPartialReply,
    });
    const receiptText = `I sent the SMS. Status: accepted/queued. Message ID: 6655442331193344`;

    emitAssistantTextDelta({
      emit,
      delta: "I sent the SMS.",
    });
    emitAssistantTextEnd({
      emit,
      content: receiptText,
    });
    await Promise.resolve();

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    const finalPayload = onPartialReply.mock.calls[0]?.[0] as PartialReplyPayload | undefined;
    expect(finalPayload).toMatchObject({
      text: "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
      delta:
        "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
      replace: true,
    });
    expect(finalPayload?.text).not.toContain("Message ID: 6655442331193344");
  });

  it("replaces unsupported SMS receipt claims before streamed block replies", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextEnd({
      emit,
      content: `[[reply_to_current]]
Sent to Jiva. To: +13522815065
From: +14155201316
Status: accepted/queued
Message ID: 6655442331193344`,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = requireBlockReplyPayload(onBlockReply);
    expect(payload.text).toBe(
      "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
    );
    expect(payload.replyToCurrent).toBe(true);
    expect(payload.replyToTag).toBe(true);
    expect(payload.text).not.toContain("Message ID: 6655442331193344");
    expect(subscription.assistantTexts.join("\n")).toContain("Message ID: 6655442331193344");
  });

  it("emits verified SMS receipt claims when embedded-agent tool delivery evidence matches", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });
    const deliveryText =
      "I sent the SMS. Status: accepted/queued. Message ID: SM_proof_redacted_1234";

    emit({
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-message-sms",
      args: {
        action: "send",
        channel: "sms",
        to: "+15551234567",
        message: "redacted proof body",
      },
    });
    emit({
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-message-sms",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "{}",
          },
        ],
        details: {
          channel: "sms",
          messageId: "SM_proof_redacted_1234",
          chatId: "+15551234567",
          receipt: {
            raw: [
              {
                channel: "sms",
                messageId: "SM_proof_redacted_1234",
                chatId: "+15551234567",
                toJid: "+15551234567",
                meta: {
                  from: "+15557654321",
                  status: "queued",
                },
              },
            ],
          },
        },
      },
    });
    await Promise.resolve();

    expect(subscription.getMessageDeliveryEvidence()).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM_proof_redacted_1234",
        status: "queued",
        recipient: "+15551234567",
      }),
    ]);

    emitAssistantTextEnd({ emit, content: deliveryText });
    await Promise.resolve();

    expectSingleBlockReplyText({
      onBlockReply,
      subscription,
      text: deliveryText,
    });
  });

  it("does not replace verified SMS receipt claims that stream across partial chunks", async () => {
    const onPartialReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onPartialReply,
    });
    const deliveryText = "I sent the SMS. Status: accepted/queued. Message ID: SM_split_proof";

    emit({
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-message-sms",
      args: {
        action: "send",
        channel: "sms",
        to: "+15551234567",
        message: "redacted proof body",
      },
    });
    emit({
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-message-sms",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "{}",
          },
        ],
        details: {
          channel: "sms",
          to: "+15551234567",
          result: {
            channel: "sms",
            messageId: "SM_split_proof",
            toJid: "+15551234567",
            status: "queued",
          },
        },
      },
    });

    emitAssistantTextDelta({
      emit,
      delta: "I sent the SMS.",
    });
    emitAssistantTextEnd({
      emit,
      content: deliveryText,
    });
    await Promise.resolve();

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls[0]?.[0]).toMatchObject({
      text: deliveryText,
      delta: deliveryText,
      replace: true,
    });
    expect(onPartialReply.mock.calls[0]?.[0]).not.toMatchObject({
      text: expect.stringContaining("cannot verify"),
    });
  });

  it("does not replace verified SMS receipt claims that stream through chunked block replies", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: { minChars: 1, maxChars: 24, breakPreference: "newline" },
    });
    const deliveryText = "I sent the SMS. Status: accepted/queued. Message ID: SM_split_proof";

    emit({
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-message-sms",
      args: {
        action: "send",
        channel: "sms",
        to: "+15551234567",
        message: "redacted proof body",
      },
    });
    emit({
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-message-sms",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "{}",
          },
        ],
        details: {
          channel: "sms",
          to: "+15551234567",
          result: {
            channel: "sms",
            messageId: "SM_split_proof",
            toJid: "+15551234567",
            status: "queued",
          },
        },
      },
    });
    await Promise.resolve();
    expect(subscription.getMessageDeliveryEvidence()).toEqual([
      expect.objectContaining({
        channel: "sms",
        providerId: "SM_split_proof",
        status: "queued",
      }),
    ]);

    emitAssistantTextDelta({
      emit,
      delta: "I sent the SMS.",
    });
    await Promise.resolve();
    expect(onBlockReply).not.toHaveBeenCalled();
    emitAssistantTextEnd({
      emit,
      content: deliveryText,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalled();
    expect(onBlockReply.mock.calls.length).toBeGreaterThan(1);
    const emittedText = onBlockReply.mock.calls
      .map((call) => (call[0] as BlockReplyPayload | undefined)?.text ?? "")
      .join("");
    expect(emittedText).toContain("I sent the SMS. Status:");
    expect(emittedText).toContain("accepted/queued");
    expect(emittedText).toContain("Message ID:");
    expect(emittedText).toContain("SM_split_proof");
    expect(emittedText).not.toContain("cannot verify");
  });

  it("replaces first-person SMS receipt claims when embedded-agent delivery has no evidence", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextEnd({
      emit,
      content: "I sent the SMS. Status: accepted/queued. Message ID: SM_proof_redacted_1234",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = requireBlockReplyPayload(onBlockReply);
    expect(payload.text).toBe(
      "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
    );
    expect(payload.text).not.toContain("SM_proof_redacted_1234");
  });

  it("replaces unsupported SMS receipt claims before chunked block replies", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: { minChars: 1, maxChars: 24, breakPreference: "newline" },
    });
    const receiptText = `[[reply_to_current]]
Sent to Jiva. To: +13522815065
From: +14155201316
Status: accepted/queued
Message ID: 6655442331193344`;

    emitAssistantTextEnd({
      emit,
      content: receiptText,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = requireBlockReplyPayload(onBlockReply);
    expect(payload.text).toBe(
      "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
    );
    expect(payload.replyToCurrent).toBe(true);
    expect(payload.replyToTag).toBe(true);
    expect(payload.text).not.toContain("Message ID: 6655442331193344");

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: receiptText }],
      } as AssistantMessage,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("holds partial SMS receipt prefixes before chunked block replies can leak them", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: { minChars: 1, maxChars: 24, breakPreference: "newline" },
    });
    const receiptText =
      "Here is the update: I sent the SMS. Status: accepted/queued. Message ID: SM_unverified_split";

    emitAssistantTextDelta({
      emit,
      delta: "Here is the update: I sent the ",
    });
    await Promise.resolve();
    expect(onBlockReply).not.toHaveBeenCalled();

    emitAssistantTextDelta({
      emit,
      delta: "SMS. Status: accepted/queued. Message ID: SM_unverified_split",
    });
    await Promise.resolve();
    expect(onBlockReply).not.toHaveBeenCalled();

    emitAssistantTextEnd({
      emit,
      content: receiptText,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = requireBlockReplyPayload(onBlockReply);
    expect(payload.text).toBe(
      "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
    );
    expect(payload.text).not.toContain("I sent the ");
    expect(payload.text).not.toContain("SM_unverified_split");
  });

  it("holds phase-aware SMS receipt prefixes before partial or block delivery can leak them", async () => {
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onPartialReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 1, maxChars: 24, breakPreference: "newline" },
    });
    const receiptText =
      "Here is the update: I sent the SMS. Status: accepted/queued. Message ID: SM_phase_split";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "Here is the update: I sent the ",
      delta: "Here is the update: I sent the ",
      id: "item_final",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    await Promise.resolve();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();

    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: receiptText,
      delta: "SMS. Status: accepted/queued. Message ID: SM_phase_split",
      id: "item_final",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    await Promise.resolve();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();

    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_end",
      text: receiptText,
      id: "item_final",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    await Promise.resolve();

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    const finalPayload = onPartialReply.mock.calls[0]?.[0] as PartialReplyPayload | undefined;
    expect(finalPayload).toMatchObject({
      text: "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
      delta:
        "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
      replace: true,
    });
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const blockPayload = requireBlockReplyPayload(onBlockReply);
    expect(blockPayload.text).toBe(
      "I cannot verify that this SMS was sent. I do not have matching current-turn delivery evidence, so please check the messaging provider history or use the verified send flow before reporting it as sent.",
    );
    expect(blockPayload.text).not.toContain("I sent the ");
    expect(blockPayload.text).not.toContain("SM_phase_split");
  });

  it("emits block replies on text_end and does not duplicate on message_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    const payload = requireBlockReplyPayload(onBlockReply);
    expect(payload?.text).toBe("Hello block");
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("message_end block-replies visible text when text_end streamed only silent NO_REPLY chunks", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit, content: "NO_REPLY" });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final visible reply." }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Final visible reply.");
    expect(subscription.assistantTexts).toEqual(["Final visible reply."]);
  });

  it("does not duplicate when message_end flushes and a late text_end arrives", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });

    emitAssistantTextDelta({ emit, delta: "Hello block" });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    // Simulate a provider that ends the message without emitting text_end.
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    // Some providers can still emit a late text_end; this must not re-emit.
    emitAssistantTextEnd({ emit, content: "Hello block" });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("emits legacy structured partials on text_end without waiting for message_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "Legacy answer",
      id: "item_legacy",
    });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_end",
      text: "Legacy answer",
      id: "item_legacy",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Legacy answer");
    expect(subscription.assistantTexts).toEqual(["Legacy answer"]);

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Legacy answer" }],
      } as AssistantMessage,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Legacy answer"]);
  });

  it("suppresses commentary block replies until a final answer is available", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    await emitSuppressedCommentary({ emit, text: "Working..." });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toStrictEqual([]);

    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Done.",
      id: "item_final",
      phase: "final_answer",
    });
    await Promise.resolve();

    emitOpenAiResponsesFinalMessageEnd({ emit, commentaryText: "Working...", finalText: "Done." });

    expectSingleBlockReplyText({ onBlockReply, subscription, text: "Done." });
  });

  it("emits the full final answer on text_end when it extends suppressed commentary", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Hello",
      id: "item_commentary",
      phase: "commentary",
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();

    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Hello world",
      delta: " world",
      id: "item_final",
      phase: "final_answer",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Hello world");
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("does not defer final_answer text_end when phase exists only in textSignature", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "Done.",
      id: "item_final",
      signaturePhase: "final_answer",
    });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_end",
      text: "Done.",
      id: "item_final",
      signaturePhase: "final_answer",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Done.");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });

  it("emits the final answer at message_end when commentary was streamed first", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    await emitSuppressedCommentary({ emit, text: "Working..." });

    emitOpenAiResponsesFinalMessageEnd({ emit, commentaryText: "Working...", finalText: "Done." });

    expectSingleBlockReplyText({ onBlockReply, subscription, text: "Done." });
  });
});
