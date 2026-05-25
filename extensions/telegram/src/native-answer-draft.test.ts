import { describe, expect, it, vi } from "vitest";
import { createNativeTelegramAnswerDraftStream } from "./native-answer-draft.js";

describe("createNativeTelegramAnswerDraftStream", () => {
  const createMockApi = () => {
    const sendMessageDraft = vi.fn(
      async (_chatId: unknown, _draftId: number, _text: string, _params?: unknown) => {},
    );
    const sendMessage = vi.fn(async (_chatId: unknown, _text: string, _params?: unknown) => ({
      message_id: 42,
    }));
    return { sendMessageDraft, sendMessage, api: { sendMessageDraft, sendMessage } };
  };

  it("returns undefined when sendMessageDraft is not available", () => {
    const stream = createNativeTelegramAnswerDraftStream({
      api: { sendMessage: vi.fn() } as never,
      chatId: 123,
    });
    expect(stream).toBeUndefined();
  });

  it("sends draft updates via sendMessageDraft", async () => {
    const { api, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    expect(stream).toBeDefined();
    stream.update("Hello");
    await stream.flush();

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendMessageDraft).toHaveBeenCalledWith(123, expect.any(Number), "Hello", undefined);
  });

  it("messageId remains undefined after stop and materialize", async () => {
    const { api } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    expect(stream.messageId()).toBeUndefined();

    stream.update("Hello world text");
    await stream.flush();
    expect(stream.messageId()).toBeUndefined();

    await stream.stop();
    expect(stream.messageId()).toBeUndefined();

    const messageId = await stream.materialize?.();
    expect(messageId).toBeUndefined();
    expect(stream.messageId()).toBeUndefined();
  });

  it("stop without finalize does not call sendMessage", async () => {
    const { api, sendMessage, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    stream.update("Partial answer");
    await stream.flush();
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);

    await stream.stop();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(stream.messageId()).toBeUndefined();
  });

  it("materialize stops without sending the final message directly", async () => {
    const { api, sendMessage, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    stream.update("Final answer");
    await stream.flush();
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);

    const messageId = await stream.materialize?.();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(messageId).toBeUndefined();
    expect(stream.messageId()).toBeUndefined();
  });

  it("clear does not call deleteMessage (drafts are ephemeral)", async () => {
    const { api } = createMockApi();
    const deleteMessage = vi.fn();
    (api as Record<string, unknown>).deleteMessage = deleteMessage;
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    stream.update("Some text");
    await stream.flush();
    await stream.clear();

    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("forceNewMessage allocates a new draftId", async () => {
    const { api, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    stream.update("First draft");
    await stream.flush();
    const firstDraftId = sendMessageDraft.mock.calls[0][1];

    stream.forceNewMessage();

    stream.update("Second draft");
    await stream.flush();
    const secondDraftId = sendMessageDraft.mock.calls[1][1];

    expect(firstDraftId).not.toBe(secondDraftId);
    expect(stream.messageId()).toBeUndefined();
  });

  it("truncates draft text exceeding 4096 chars", async () => {
    const { api, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    const longText = "x".repeat(5000);
    stream.update(longText);
    await stream.flush();

    const sentText = sendMessageDraft.mock.calls[0][2];
    expect(sentText.length).toBe(4096);
  });

  it("disables native draft updates after sendMessageDraft error", async () => {
    const sendMessageDraft = vi.fn(async () => {
      throw new Error("Bad Request: method is unavailable");
    });
    const warn = vi.fn();
    const stream = createNativeTelegramAnswerDraftStream({
      api: { sendMessageDraft, sendMessage: vi.fn() } as never,
      chatId: 123,
      warn,
    })!;

    stream.update("Failing draft");
    await stream.flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("native answer draft failed"));

    sendMessageDraft.mockClear();
    stream.update("After failure");
    await stream.flush();
    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(stream.suppressNonFinalFallback?.()).toBe(true);
  });

  it("sendMayHaveLanded returns false during streaming", async () => {
    const { api } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    stream.update("Text");
    await stream.flush();
    expect(stream.sendMayHaveLanded?.()).toBe(false);
  });

  it("passes thread params to sendMessageDraft", async () => {
    const { api, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
      thread: { id: 456, scope: "dm" },
    })!;

    stream.update("Threaded text");
    await stream.flush();

    expect(sendMessageDraft).toHaveBeenCalledWith(123, expect.any(Number), "Threaded text", {
      message_thread_id: 456,
    });
  });

  it("deduplicates identical draft updates", async () => {
    const { api, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    stream.update("Same text");
    await stream.flush();
    stream.update("Same text");
    await stream.flush();

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
  });

  it("respects minInitialChars debounce", async () => {
    const { api, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
      minInitialChars: 20,
    })!;

    stream.update("short");
    await stream.flush();
    expect(sendMessageDraft).not.toHaveBeenCalled();

    stream.update("this is long enough text");
    await stream.flush();
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
  });

  it("materialize calls stop and returns undefined", async () => {
    const { api } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    stream.update("Materialize test");
    const messageId = await stream.materialize?.();
    expect(messageId).toBeUndefined();
  });

  it("applies renderText parse mode to draft updates", async () => {
    const { api, sendMessageDraft, sendMessage } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
      renderText: (text) => ({ text: `<b>${text}</b>`, parseMode: "HTML" }),
    })!;

    stream.update("bold");
    await stream.flush();

    expect(sendMessageDraft).toHaveBeenCalledWith(123, expect.any(Number), "<b>bold</b>", {
      parse_mode: "HTML",
    });

    await stream.materialize?.();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("lastDeliveredText returns raw text after formatted draft update", async () => {
    const { api } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
      renderText: (text) => ({ text: `<b>${text}</b>`, parseMode: "HTML" }),
    })!;

    stream.update("answer text");
    await stream.flush();
    await stream.materialize?.();

    expect(stream.messageId()).toBeUndefined();
    expect(stream.lastDeliveredText?.()).toBe("answer text");
  });

  it("isActive returns true only after a draft update lands", async () => {
    const { api } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    expect(stream.isActive?.()).toBe(false);

    stream.update("Some text");
    await stream.flush();
    expect(stream.isActive?.()).toBe(true);

    await stream.stop();
    expect(stream.isActive?.()).toBe(false);
  });

  it("isActive returns false after materialize", async () => {
    const { api } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    expect(stream.isActive?.()).toBe(false);

    stream.update("Final text");
    await stream.flush();
    expect(stream.isActive?.()).toBe(true);

    await stream.materialize?.();
    expect(stream.isActive?.()).toBe(false);
  });

  it("isActive stays false before minInitialChars allows the first draft", async () => {
    const { api, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
      minInitialChars: 10,
    })!;

    stream.update("short");
    await stream.flush();

    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(stream.isActive?.()).toBe(false);
  });

  it("does not directly send long draft text on materialize", async () => {
    const { api, sendMessage, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
    })!;

    const longText = "x".repeat(5000);
    stream.update(longText);
    await stream.flush();

    const draftText = sendMessageDraft.mock.calls[0][2];
    expect(draftText.length).toBe(4096);

    const messageId = await stream.materialize?.();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(messageId).toBeUndefined();
  });

  it("truncates rendered draft text exceeding 4096 chars", async () => {
    const { api, sendMessage, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
      renderText: (text) => ({ text: `<b>${text}</b>`, parseMode: "HTML" as const }),
    })!;

    const longText = "y".repeat(5000);
    stream.update(longText);
    await stream.flush();

    const draftText = sendMessageDraft.mock.calls[0][2];
    expect(draftText.length).toBe(4096);

    const messageId = await stream.materialize?.();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(messageId).toBeUndefined();
  });

  it("downgrades overlong HTML draft previews to plain text", async () => {
    const { api, sendMessageDraft } = createMockApi();
    const stream = createNativeTelegramAnswerDraftStream({
      api: api as never,
      chatId: 123,
      renderText: (text) => ({ text: `<b>${text}</b>`, parseMode: "HTML" as const }),
    })!;

    stream.update("z".repeat(5000));
    await stream.flush();

    const call = sendMessageDraft.mock.calls[0];
    expect(call[0]).toBe(123);
    expect(call[2]).toBe("z".repeat(4096));
    expect(call[3]).toBeUndefined();
  });

  it("does not materialize stale text after draft error", async () => {
    let draftCallCount = 0;
    const sendMessageDraft = vi.fn(async () => {
      draftCallCount++;
      if (draftCallCount > 1) {
        throw new Error("Bad Request: draft expired");
      }
    });
    const sendMessage = vi.fn(async () => ({ message_id: 99 }));
    const warn = vi.fn();
    const stream = createNativeTelegramAnswerDraftStream({
      api: { sendMessageDraft, sendMessage } as never,
      chatId: 123,
      warn,
    })!;

    stream.update("First chunk");
    await stream.flush();
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(stream.previewRevision?.()).toBe(1);

    stream.update("First chunk plus more text after expiry");
    await stream.flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("native answer draft failed"));
    expect(stream.isActive?.()).toBe(false);

    stream.update("Final answer after expiry");
    await stream.flush();

    const messageId = await stream.materialize?.();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(messageId).toBeUndefined();
  });

  it("sendMayHaveLanded is false after draft expiry disables materialize", async () => {
    let draftCallCount = 0;
    const sendMessageDraft = vi.fn(async () => {
      draftCallCount++;
      if (draftCallCount > 1) {
        throw new Error("Bad Request: draft expired");
      }
    });
    const sendMessage = vi.fn(async () => {
      throw Object.assign(new Error("403: Forbidden: bot was blocked by the user"), {
        error_code: 403,
      });
    });
    const warn = vi.fn();
    const stream = createNativeTelegramAnswerDraftStream({
      api: { sendMessageDraft, sendMessage } as never,
      chatId: 123,
      warn,
    })!;

    stream.update("Text before expiry");
    await stream.flush();
    stream.update("Text after expiry triggers error");
    await stream.flush();

    await stream.materialize?.();
    expect(stream.messageId()).toBeUndefined();
    expect(stream.sendMayHaveLanded?.()).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
