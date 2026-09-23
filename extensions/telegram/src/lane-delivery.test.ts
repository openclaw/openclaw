// Telegram tests cover lane delivery plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import {
  createHarness,
  deliverFinalAnswer,
  deliverProjectedFinalAnswer,
  expectPreviewFinalized,
  expectRecordedPreview,
  expectSentPayload,
} from "./lane-delivery.test-support.js";

const HELLO_FINAL = "Hello final";
describe("createLaneTextDeliverer", () => {
  it("preserves a finalized preview receipt when the final history write fails", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const historyFailure = new Error("retained Telegram history write failed");
    harness.recordPromptContextPreview.mockRejectedValueOnce(historyFailure);

    const result = await deliverProjectedFinalAnswer(harness, HELLO_FINAL);

    expect(result).toMatchObject({
      kind: "preview-finalized-partial",
      delivery: {
        content: HELLO_FINAL,
        messageId: 999,
        receipt: {
          primaryPlatformMessageId: "999",
          platformMessageIds: ["999"],
        },
      },
      error: historyFailure,
    });
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("claims an equal visible preview and survives a cleanup-only crash", async () => {
    const events: string[] = [];
    const answer = createTestDraftStream({ messageId: 999 });
    answer.update(HELLO_FINAL);
    answer.update.mockClear();
    const harness = createHarness({ answerStream: answer });
    harness.stopDraftLane.mockImplementationOnce(async () => {
      events.push("finalize");
      throw new Error("injected finalization crash");
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("custody");
    });

    // The preview text is already on screen: custody must be claimed, and a
    // cleanup crash must not convert the accepted preview into a send failure.
    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: HELLO_FINAL,
      payload: { text: HELLO_FINAL },
      infoKind: "final",
      onPlatformSendDispatch,
    });

    expect(events).toEqual(["custody", "finalize"]);
    expect(answer.update).not.toHaveBeenCalled();
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    const delivery = expectPreviewFinalized(result);
    expect(delivery.messageId).toBe(999);
    expect(delivery.content).toBe(HELLO_FINAL);
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("keeps throwing late media failures without a concrete preview receipt", async () => {
    const answer = createTestDraftStream();
    const harness = createHarness({ answerStream: answer });
    const mediaError = new Error("media rejected");
    answer.sendMayHaveLanded.mockReturnValue(true);
    harness.lanes.answer.hasStreamedMessage = true;
    harness.sendPayload.mockRejectedValueOnce(mediaError);

    await expect(
      harness.deliverLaneText({
        laneName: "answer",
        text: "photo",
        payload: { text: "photo", mediaUrl: "https://example.com/a.png" },
        infoKind: "final",
      }),
    ).rejects.toBe(mediaError);
  });

  it("keeps text on late voice media so blocked voice sends can fall back", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "resolved voice fallback",
      payload: {
        text: "stale voice fallback",
        mediaUrl: "https://example.com/note.ogg",
        audioAsVoice: true,
      },
      infoKind: "final",
    });

    expectPreviewFinalized(result);
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/note.ogg",
        audioAsVoice: true,
        spokenText: "resolved voice fallback",
      },
      true,
    );
  });

  it("keeps inline buttons on the streamed text instead of late media", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;
    const buttons = [[{ text: "OK", callback_data: "ok" }]];

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { buttons, effect: "spark" }, other: true },
      },
      infoKind: "final",
      buttons,
    });

    expectPreviewFinalized(result);
    expect(harness.editStreamMessage).toHaveBeenCalledWith({
      laneName: "answer",
      messageId: 999,
      text: "photo",
      buttons,
    });
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { effect: "spark" }, other: true },
      },
      true,
    );
  });

  it("does not retry late media when the stream button edit fails", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;
    harness.editStreamMessage.mockRejectedValueOnce(new Error("400: button rejected"));
    const buttons = [[{ text: "OK", callback_data: "ok" }]];

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { buttons, effect: "spark" }, other: true },
      },
      infoKind: "final",
      buttons,
    });

    expect(result).toMatchObject({
      kind: "preview-finalized-partial",
      delivery: { messageId: 999, receipt: { primaryPlatformMessageId: "999" } },
      error: expect.objectContaining({ message: "400: button rejected" }),
    });
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("falls back with only the unsent suffix after retained pages are rate-limited", async () => {
    vi.useFakeTimers();
    try {
      const attempts: string[] = [];
      const api = {
        sendMessage: vi.fn(async (_chatId: string, text: string) => {
          attempts.push(text);
          if (attempts.length > 1) {
            throw Object.assign(new Error("429: retry after 1"), {
              error_code: 429,
              parameters: { retry_after: 1 },
            });
          }
          return { message_id: 997 };
        }),
        editMessageText: vi.fn().mockResolvedValue(true),
        deleteMessage: vi.fn().mockResolvedValue(true),
      };
      const retainedPages: Array<{ messageId: number; text: string }> = [];
      const answer = createTelegramDraftStream({
        api: api as never,
        chatId: "123",
        maxChars: 10,
        throttleMs: 250,
        renderText: (text) => ({ text: renderTelegramHtmlText(text), parseMode: "HTML" }),
        onRetainedPage: (page) => {
          retainedPages.push({ messageId: page.messageId, text: page.textSnapshot });
        },
      });
      const fullAnswer = "1234567890`<b>x</b>`";
      const renderedSuffix = "<code>&lt;b&gt;x&lt;/b&gt;</code>";
      answer.update(fullAnswer);
      await answer.flush();
      expect(attempts).toEqual(["1234567890"]);

      const harness = createHarness({ answerStream: answer });
      harness.lanes.answer.retainedPromptContextPages = retainedPages;
      harness.sendPayload.mockImplementationOnce(async (fallbackPayload, options) => {
        await options?.promptContextSequence?.accept({
          messageId: 998,
          text: telegramHtmlToPlainTextFallback(fallbackPayload.text ?? ""),
        });
        await options?.promptContextSequence?.finish();
        return { visibleReplySent: true };
      });
      const deliveryPromise = deliverProjectedFinalAnswer(harness, fullAnswer);

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual(["1234567890", renderedSuffix]);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual(["1234567890", renderedSuffix]);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toEqual(["1234567890", renderedSuffix, renderedSuffix]);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual(["1234567890", renderedSuffix, renderedSuffix]);
      await vi.advanceTimersByTimeAsync(1);
      const result = await deliveryPromise;

      expect(result.kind).toBe("sent");
      expect(attempts).toEqual(["1234567890", renderedSuffix, renderedSuffix, renderedSuffix]);
      expectRecordedPreview(harness.recordPromptContextPreview, 0, {
        messageId: 997,
        text: "1234567890",
        partIndex: 0,
        finalPart: false,
      });
      expectRecordedPreview(harness.recordPromptContextPreview, 1, {
        messageId: 998,
        text: "<b>x</b>",
        partIndex: 1,
        finalPart: true,
      });
      expect(harness.recordPromptContextPreview).toHaveBeenCalledTimes(2);
      expect(harness.sendPayload).toHaveBeenCalledWith(
        { text: renderedSuffix },
        expect.objectContaining({
          afterAcceptedDraft: true,
          textMode: "html",
        }),
      );
      expect(api.deleteMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the streamed message when stop may have landed without a message id", async () => {
    const answer = createTestDraftStream();
    answer.sendMayHaveLanded.mockReturnValue(true);
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result).toMatchObject({
      kind: "preview-retained",
      deliveryResult: {
        visibleReplySent: false,
        suppression: { reason: "adapter_returned_no_identity" },
      },
    });
    expect(answer.update).toHaveBeenCalledWith(HELLO_FINAL);
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("waits for a concrete streamed tool message before attaching buttons", async () => {
    const answer = createTestDraftStream();
    answer.waitForInFlight.mockImplementation(async () => answer.setMessageId(999));
    const harness = createHarness({ answerStream: answer });
    const buttons = [[{ text: "OK", callback_data: "ok" }]];

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: HELLO_FINAL,
      payload: { text: HELLO_FINAL, channelData: { telegram: { buttons } } },
      infoKind: "tool",
      buttons,
    });

    expect(answer.waitForInFlight).toHaveBeenCalledOnce();
    expect(result.kind).toBe("preview-updated");
    expect(harness.editStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 999, buttons }),
    );
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });
});
