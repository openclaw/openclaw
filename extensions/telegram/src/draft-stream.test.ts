// Telegram tests cover draft stream plugin behavior.
import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

type TelegramDraftStreamParams = Parameters<typeof createTelegramDraftStream>[0];

function createMockDraftApi(sendMessageImpl?: () => Promise<{ message_id: number }>) {
  const sendRichMessage = vi.fn(sendMessageImpl ?? (async () => ({ message_id: 17 })));
  const editRichMessageText = vi.fn().mockResolvedValue(true);
  return {
    sendMessage: vi.fn(sendMessageImpl ?? (async () => ({ message_id: 17 }))),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    raw: {
      sendRichMessage,
      editMessageText: editRichMessageText,
    },
  };
}

function createForumDraftStream(api: ReturnType<typeof createMockDraftApi>) {
  return createThreadedDraftStream(api, { id: 99, scope: "forum" });
}

function createThreadedDraftStream(
  api: ReturnType<typeof createMockDraftApi>,
  thread: { id: number; scope: "forum" | "dm" },
) {
  return createDraftStream(api, { thread });
}

function createDraftStream(
  api: ReturnType<typeof createMockDraftApi>,
  overrides: Omit<Partial<TelegramDraftStreamParams>, "api" | "chatId"> = {},
) {
  return createTelegramDraftStream({
    api: api as unknown as Bot["api"],
    chatId: 123,
    ...overrides,
  });
}

async function expectInitialForumSend(
  api: ReturnType<typeof createMockDraftApi>,
  text = "Hello",
): Promise<void> {
  await vi.waitFor(() =>
    expect(api.raw.sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: { markdown: text },
      message_thread_id: 99,
    }),
  );
}

function expectRichSend(
  api: ReturnType<typeof createMockDraftApi>,
  text: string,
  params: Record<string, unknown> = {},
) {
  expect(api.raw.sendRichMessage).toHaveBeenCalledWith({
    chat_id: 123,
    rich_message: { markdown: text },
    ...params,
  });
}

function expectNthRichSend(
  api: ReturnType<typeof createMockDraftApi>,
  call: number,
  text: string,
  params: Record<string, unknown> = {},
) {
  expect(api.raw.sendRichMessage).toHaveBeenNthCalledWith(call, {
    chat_id: 123,
    rich_message: { markdown: text },
    ...params,
  });
}

function expectRichEdit(api: ReturnType<typeof createMockDraftApi>, text: string) {
  expect(api.raw.editMessageText).toHaveBeenCalledWith({
    chat_id: 123,
    message_id: 17,
    rich_message: { markdown: text },
  });
}

function createForceNewMessageHarness(params: { throttleMs?: number } = {}) {
  const api = createMockDraftApi();
  api.raw.sendRichMessage
    .mockResolvedValueOnce({ message_id: 17 })
    .mockResolvedValueOnce({ message_id: 42 });
  const stream = createDraftStream(
    api,
    params.throttleMs != null ? { throttleMs: params.throttleMs } : {},
  );
  return { api, stream };
}

describe("createTelegramDraftStream", () => {
  it("sends stream preview message with message_thread_id when provided", async () => {
    const api = createMockDraftApi();
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await expectInitialForumSend(api);
  });

  it("edits existing stream preview message on subsequent updates", async () => {
    const api = createMockDraftApi();
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await expectInitialForumSend(api);
    await (api.raw.sendRichMessage.mock.results[0]?.value as Promise<unknown>);

    stream.update("Hello again");
    await stream.flush();

    expectRichEdit(api, "Hello again");
  });

  it("waits for in-flight updates before final flush edit", async () => {
    let resolveSend: ((value: { message_id: number }) => void) | undefined;
    const firstSend = new Promise<{ message_id: number }>((resolve) => {
      resolveSend = resolve;
    });
    const api = createMockDraftApi(() => firstSend);
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await vi.waitFor(() => expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1));
    stream.update("Hello final");
    const flushPromise = stream.flush();
    expect(api.raw.editMessageText).not.toHaveBeenCalled();

    resolveSend?.({ message_id: 17 });
    await flushPromise;

    expectRichEdit(api, "Hello final");
  });

  it("omits message_thread_id for general topic id", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 1, scope: "forum" });

    stream.update("Hello");

    await vi.waitFor(() => expectRichSend(api, "Hello"));
  });

  it("uses rich send/edit for dm thread previews", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    stream.update("Hello");
    await vi.waitFor(() => expectRichSend(api, "Hello", { message_thread_id: 42 }));
    expect(api.raw.editMessageText).not.toHaveBeenCalled();

    stream.update("Hello again");
    await stream.flush();

    expectRichEdit(api, "Hello again");
  });

  it("tracks when a message preview first became visible", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-26T01:00:00.000Z"));
      const api = createMockDraftApi();
      const stream = createDraftStream(api);

      stream.update("Hello");
      await stream.flush();

      expect(stream.visibleSinceMs?.()).toBe(Date.parse("2026-04-26T01:00:00.000Z"));

      vi.setSystemTime(new Date("2026-04-26T01:01:00.000Z"));
      stream.update("Hello again");
      await stream.flush();

      expect(stream.visibleSinceMs?.()).toBe(Date.parse("2026-04-26T01:00:00.000Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["forum", "dm"] as const)(
    "does not retry %s message preview sends without the topic id",
    async (scope) => {
      const api = createMockDraftApi();
      api.raw.sendRichMessage.mockRejectedValueOnce(
        new Error("400: Bad Request: message thread not found"),
      );
      const warn = vi.fn();
      const stream = createDraftStream(api, {
        thread: { id: 42, scope },
        warn,
      });

      stream.update("Hello");
      await stream.flush();

      expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
      expectRichSend(api, "Hello", { message_thread_id: 42 });
      expect(warn).toHaveBeenCalledWith(
        "telegram stream preview failed: 400: Bad Request: message thread not found",
      );
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("retrying without thread")),
      ).toBe(false);
    },
  );

  it("does not finalize stale preview text after a stopped send failure", async () => {
    const api = createMockDraftApi();
    api.raw.sendRichMessage.mockRejectedValueOnce(new Error("temporary send failure"));
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    await stream.stop();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    expectRichSend(api, "Hello");
    expect(warn).toHaveBeenCalledWith("telegram stream preview failed: temporary send failure");
  });

  it("keeps allow_sending_without_reply on message previews that target a reply", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      replyToMessageId: 411,
    });

    stream.update("Hello");
    await stream.flush();

    expectRichSend(api, "Hello", {
      message_thread_id: 42,
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    });
  });

  it("materializes message previews using rendered rich HTML", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      renderText: (text) => ({
        text: text.replace("**bold**", "<b>bold</b>"),
        richMessage: { html: text.replace("**bold**", "<b>bold</b>") },
      }),
    });

    stream.update("**bold**");
    await stream.flush();
    const materializedId = await stream.materialize?.();

    expect(materializedId).toBe(17);
    expect(api.raw.sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: { html: "<b>bold</b>" },
      message_thread_id: 42,
    });
    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
  });

  it("returns existing preview id when materializing message transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
    });

    stream.update("Hello");
    await stream.flush();
    const materializedId = await stream.materialize?.();

    expect(materializedId).toBe(17);
    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
  });

  it("deletes message preview on clear after finalization", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.stop();
    await stream.clear();

    expectRichSend(api, "Hello", { message_thread_id: 42 });
    expectRichEdit(api, "Hello again");
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
  });

  it("creates new message after forceNewMessage is called", async () => {
    const { api, stream } = createForceNewMessageHarness();

    // First message
    stream.update("Hello");
    await stream.flush();
    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);

    // Normal edit (same message)
    stream.update("Hello edited");
    await stream.flush();
    expectRichEdit(api, "Hello edited");

    // Force new message (e.g. after thinking block ends)
    stream.forceNewMessage();
    stream.update("After thinking");
    await stream.flush();

    // Should have sent a second new message, not edited the first
    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
    expectNthRichSend(api, 2, "After thinking");
  });

  it("creates new message after cleanup and forceNewMessage", async () => {
    const { api, stream } = createForceNewMessageHarness();

    stream.update("Stale preview");
    await stream.flush();

    await stream.clear();
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);

    stream.forceNewMessage();
    stream.update("Next preview");
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
    expectNthRichSend(api, 2, "Next preview");
  });

  it("sends first update immediately after forceNewMessage within throttle window", async () => {
    vi.useFakeTimers();
    try {
      const { api, stream } = createForceNewMessageHarness({ throttleMs: 1000 });

      stream.update("Hello");
      await vi.waitFor(() => expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1));

      stream.update("Hello edited");
      expect(api.raw.editMessageText).not.toHaveBeenCalled();

      stream.forceNewMessage();
      stream.update("Second message");
      await vi.waitFor(() => expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2));
      expectNthRichSend(api, 2, "Second message");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an old message when forceNewMessage races an in-flight send", async () => {
    let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
    const firstSend = new Promise<{ message_id: number }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const api = createMockDraftApi();
    api.raw.sendRichMessage
      .mockReturnValueOnce(firstSend)
      .mockResolvedValueOnce({ message_id: 42 });
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, { onSupersededPreview });

    stream.update("Message A partial");
    await vi.waitFor(() => expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1));

    stream.forceNewMessage();
    stream.update("Message B partial");

    resolveFirstSend?.({ message_id: 17 });
    await stream.flush();

    expect(onSupersededPreview).toHaveBeenCalledTimes(1);
    const [supersededPreview] = onSupersededPreview.mock.calls.at(0) ?? [];
    expect(supersededPreview).toEqual({
      messageId: 17,
      textSnapshot: "Message A partial",
      visibleSinceMs: supersededPreview.visibleSinceMs,
      retain: true,
    });
    expect(typeof supersededPreview.visibleSinceMs).toBe("number");
    expect(Number.isFinite(supersededPreview.visibleSinceMs)).toBe(true);
    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
    expectNthRichSend(api, 2, "Message B partial");
    expect(api.raw.editMessageText).not.toHaveBeenCalledWith({
      chat_id: 123,
      message_id: 17,
      rich_message: { markdown: "Message B partial" },
    });
  });

  it("marks sendMayHaveLanded after an ambiguous first preview send failure", async () => {
    const api = createMockDraftApi();
    api.raw.sendRichMessage.mockRejectedValueOnce(
      new Error("timeout after Telegram accepted send"),
    );
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(stream.sendMayHaveLanded?.()).toBe(true);
  });

  async function expectSendMayHaveLandedStateAfterFirstFailure(error: Error, expected: boolean) {
    const api = createMockDraftApi();
    api.raw.sendRichMessage.mockRejectedValueOnce(error);
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(stream.sendMayHaveLanded?.()).toBe(expected);
  }

  it("retries pre-connect first preview send failures instead of stopping", async () => {
    const api = createMockDraftApi();
    api.raw.sendRichMessage.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(stream.sendMayHaveLanded?.()).toBe(false);
    expect(stream.messageId()).toBe(17);
  });

  it("clears sendMayHaveLanded on Telegram 4xx client rejections", async () => {
    await expectSendMayHaveLandedStateAfterFirstFailure(
      Object.assign(new Error("403: Forbidden"), { error_code: 403 }),
      false,
    );
  });

  it("treats message-is-not-modified edits as delivered", async () => {
    const api = createMockDraftApi();
    api.raw.editMessageText.mockRejectedValueOnce(
      Object.assign(
        new Error("Call to 'editMessageText' failed! (400: Bad Request: message is not modified)"),
        { error_code: 400 },
      ),
    );
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.flush();
    stream.update("Hello more");
    await stream.flush();

    expect(api.raw.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.raw.editMessageText).toHaveBeenLastCalledWith({
      chat_id: 123,
      message_id: 17,
      rich_message: { markdown: "Hello more" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries the preview edit after a transient network failure", async () => {
    const api = createMockDraftApi();
    api.raw.editMessageText.mockRejectedValueOnce(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    );
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.flush();
    expect(warn).toHaveBeenCalledWith(
      "telegram stream preview edit failed (retrying): read ECONNRESET",
    );

    await stream.flush();

    expect(api.raw.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.raw.editMessageText).toHaveBeenLastCalledWith({
      chat_id: 123,
      message_id: 17,
      rich_message: { markdown: "Hello again" },
    });
    expect(stream.lastDeliveredText?.()).toBe("Hello again");
  });

  it("suspends preview edits for retry_after during flood control", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockDraftApi();
      api.raw.editMessageText.mockRejectedValueOnce(
        Object.assign(
          new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 1)"),
          { error_code: 429, parameters: { retry_after: 1 } },
        ),
      );
      const stream = createDraftStream(api);

      stream.update("Hello");
      await stream.flush();
      stream.update("Hello again");
      await stream.flush();
      stream.update("Hello more");
      await stream.flush();
      expect(api.raw.editMessageText).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1100);
      await stream.flush();

      expect(api.raw.editMessageText).toHaveBeenCalledTimes(2);
      expect(api.raw.editMessageText).toHaveBeenLastCalledWith({
        chat_id: 123,
        message_id: 17,
        rich_message: { markdown: "Hello more" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the preview after repeated retryable edit failures", async () => {
    const api = createMockDraftApi();
    api.raw.editMessageText.mockRejectedValue(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    );
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.flush();
    await stream.flush();
    await stream.flush();
    await stream.flush();
    await stream.flush();

    expect(api.raw.editMessageText).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith("telegram stream preview failed: read ECONNRESET");
  });

  it("supports rendered previews with rich HTML", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      renderText: (text) => ({ text: `<i>${text}</i>`, richMessage: { html: `<i>${text}</i>` } }),
    });

    stream.update("hello");
    await stream.flush();
    expect(api.raw.sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: { html: "<i>hello</i>" },
    });

    stream.update("hello again");
    await stream.flush();
    expect(api.raw.editMessageText).toHaveBeenCalledWith({
      chat_id: 123,
      message_id: 17,
      rich_message: { html: "<i>hello again</i>" },
    });
  });

  it("keeps rich rendered previews above the old text-message limit", async () => {
    const richApi = {
      sendRichMessage: vi.fn(async () => ({ message_id: 17 })),
      editMessageText: vi.fn(async () => true),
    };
    const api = {
      ...createMockDraftApi(),
      raw: richApi,
    };
    const text = `# Long\n\n${"rich line\n".repeat(600)}`;
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      renderText: (value) => ({
        text: value,
        richMessage: { markdown: value },
      }),
    });

    stream.update(text);
    await stream.flush();

    expect(richApi.sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: { markdown: text.trimEnd() },
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps non-final overflow in one editable preview", async () => {
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, { maxChars: 20, onSupersededPreview });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    expectNthRichSend(api, 1, "Hello world");
    expectRichEdit(api, "Hello world foo bar");
    expect(onSupersededPreview).not.toHaveBeenCalled();
    expect(stream.lastDeliveredText?.()).toBe("Hello world foo bar");
  });

  it("does not retain non-final overflow preview pages", async () => {
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 20,
      onSupersededPreview,
    });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    expectRichEdit(api, "Hello world foo bar");
    expect(onSupersededPreview).not.toHaveBeenCalled();
  });

  it("continues in a new message when a final rendered preview crosses maxChars", async () => {
    const api = createMockDraftApi();
    api.raw.sendRichMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 });
    const stream = createDraftStream(api, { maxChars: 20 });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.stop();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
    expectNthRichSend(api, 1, "Hello world");
    expectNthRichSend(api, 2, "foo bar baz qux");
  });

  it("clamps a first oversized non-final preview", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { maxChars: 10 });

    stream.update("1234567890ABCDEFGHIJ");
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    expectNthRichSend(api, 1, "1234567890");
    expect(stream.lastDeliveredText?.()).toBe("1234567890");
  });

  it("finalizes overflow that was hidden by a clamped non-final preview", async () => {
    const api = createMockDraftApi();
    api.raw.sendRichMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 });
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 10,
      onSupersededPreview,
    });

    stream.update("1234567890ABCDEFGHIJ");
    await stream.flush();
    await stream.stop();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
    expectNthRichSend(api, 1, "1234567890");
    expectNthRichSend(api, 2, "ABCDEFGHIJ");
    expect(stream.lastDeliveredText?.()).toBe("1234567890ABCDEFGHIJ");
    expect(onSupersededPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 17,
        retain: true,
      }),
    );
  });

  it("continues finalizing more than two overflow chunks after a clamped preview", async () => {
    const api = createMockDraftApi();
    api.raw.sendRichMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 })
      .mockResolvedValueOnce({ message_id: 43 });
    const stream = createDraftStream(api, { maxChars: 10 });

    stream.update("1234567890ABCDEFGHIJKLMNOPQRST");
    await stream.flush();
    await stream.stop();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(3);
    expectNthRichSend(api, 1, "1234567890");
    expectNthRichSend(api, 2, "ABCDEFGHIJ");
    expectNthRichSend(api, 3, "KLMNOPQRST");
    expect(stream.lastDeliveredText?.()).toBe("1234567890ABCDEFGHIJKLMNOPQRST");
  });

  it("retains final overflow preview pages", async () => {
    const api = createMockDraftApi();
    api.raw.sendRichMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 });
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 20,
      onSupersededPreview,
    });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.stop();

    expect(onSupersededPreview).toHaveBeenCalledTimes(1);
    const [supersededPreview] = onSupersededPreview.mock.calls.at(0) ?? [];
    expect(supersededPreview).toEqual({
      messageId: 17,
      textSnapshot: "Hello world",
      visibleSinceMs: supersededPreview.visibleSinceMs,
      retain: true,
    });
    expect(typeof supersededPreview.visibleSinceMs).toBe("number");
    expect(Number.isFinite(supersededPreview.visibleSinceMs)).toBe(true);
  });

  it("enforces maxChars after renderText expansion", async () => {
    const api = createMockDraftApi();
    const warn = vi.fn();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 100,
      renderText: () => ({
        text: `<b>${"<".repeat(120)}</b>`,
        richMessage: { html: `<b>${"<".repeat(120)}</b>` },
      }),
      warn,
    });

    stream.update("short raw text");
    await stream.flush();

    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
    expect(api.raw.editMessageText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("telegram stream preview stopped (text length 127 > 100)");
  });
});

describe("draft stream initial message debounce", () => {
  const createMockApi = () => createMockDraftApi(async () => ({ message_id: 42 }));

  function createDebouncedStream(api: ReturnType<typeof createMockApi>, minInitialChars = 30) {
    return createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      minInitialChars,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isFinal has highest priority", () => {
    it("sends immediately on stop() even with 1 character", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Y");
      await stream.stop();
      await stream.flush();

      expectRichSend(api, "Y");
    });

    it("sends immediately on stop() with short sentence", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Ok.");
      await stream.stop();
      await stream.flush();

      expectRichSend(api, "Ok.");
    });
  });

  describe("minInitialChars threshold", () => {
    it("does not send first message below threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Processing");
      await stream.flush();

      expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
    });

    it("does not send a first message when discard() supersedes a short partial", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Processing");
      await stream.discard?.();
      await stream.flush();

      expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
      expect(api.raw.editMessageText).not.toHaveBeenCalled();
    });

    it("sends first message when reaching threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request..");
      await stream.flush();

      expect(api.raw.sendRichMessage).toHaveBeenCalled();
    });

    it("works with longer text above threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request, please wait a moment");
      await stream.flush();

      expect(api.raw.sendRichMessage).toHaveBeenCalled();
    });
  });

  describe("subsequent updates after first message", () => {
    it("edits normally after first message is sent", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request..");
      await stream.flush();
      expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);

      stream.update("I am processing your request.. and summarizing");
      await stream.flush();

      expect(api.raw.editMessageText).toHaveBeenCalled();
      expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("default behavior without debounce params", () => {
    it("sends rich markdown immediately without minInitialChars set", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
      });

      stream.update("Hi");
      await stream.flush();

      expectRichSend(api, "Hi");
    });
  });
});
