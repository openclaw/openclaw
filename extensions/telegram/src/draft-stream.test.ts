// Telegram tests cover draft stream plugin behavior.
import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";
import type { TelegramInputRichMessage } from "./rich-message.js";

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
    expect(api.sendMessage).toHaveBeenCalledWith(123, text, {
      message_thread_id: 99,
    }),
  );
}

function expectPreviewSend(
  api: ReturnType<typeof createMockDraftApi>,
  text: string,
  params: Record<string, unknown> = {},
) {
  expect(api.sendMessage).toHaveBeenCalledWith(123, text, params);
}

function expectNthPreviewSend(
  api: ReturnType<typeof createMockDraftApi>,
  call: number,
  text: string,
  params: Record<string, unknown> = {},
) {
  expect(api.sendMessage).toHaveBeenNthCalledWith(call, 123, text, params);
}

function requireSendMessageCallText(
  api: ReturnType<typeof createMockDraftApi>,
  callIndex: number,
): string {
  const calls = api.sendMessage.mock.calls as unknown[][];
  const call = calls[callIndex];
  expect(call, `sendMessage call ${callIndex}`).toBeDefined();
  const text = call?.[1];
  expect(typeof text).toBe("string");
  return typeof text === "string" ? text : "";
}

function expectPreviewEdit(
  api: ReturnType<typeof createMockDraftApi>,
  text: string,
  params?: Record<string, unknown>,
) {
  if (params) {
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, text, params);
    return;
  }
  expect(api.editMessageText).toHaveBeenCalledWith(123, 17, text);
}

function createForceNewMessageHarness(params: { throttleMs?: number } = {}) {
  const api = createMockDraftApi();
  api.sendMessage
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
    await (api.sendMessage.mock.results[0]?.value as Promise<unknown>);

    stream.update("Hello again");
    await stream.flush();

    expectPreviewEdit(api, "Hello again");
  });

  it("waits for in-flight updates before final flush edit", async () => {
    let resolveSend: ((value: { message_id: number }) => void) | undefined;
    const firstSend = new Promise<{ message_id: number }>((resolve) => {
      resolveSend = resolve;
    });
    const api = createMockDraftApi(() => firstSend);
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    stream.update("Hello final");
    const flushPromise = stream.flush();
    expect(api.editMessageText).not.toHaveBeenCalled();

    resolveSend?.({ message_id: 17 });
    await flushPromise;

    expectPreviewEdit(api, "Hello final");
  });

  it("omits message_thread_id for general topic id", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 1, scope: "forum" });

    stream.update("Hello");

    await vi.waitFor(() => expectPreviewSend(api, "Hello"));
  });

  it("uses text send/edit for dm thread previews", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    stream.update("Hello");
    await vi.waitFor(() => expectPreviewSend(api, "Hello", { message_thread_id: 42 }));
    expect(api.editMessageText).not.toHaveBeenCalled();

    stream.update("Hello again");
    await stream.flush();

    expectPreviewEdit(api, "Hello again");
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
      api.sendMessage.mockRejectedValueOnce(
        new Error("400: Bad Request: message thread not found"),
      );
      const warn = vi.fn();
      const stream = createDraftStream(api, {
        thread: { id: 42, scope },
        warn,
      });

      stream.update("Hello");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expectPreviewSend(api, "Hello", { message_thread_id: 42 });
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
    api.sendMessage.mockRejectedValueOnce(new Error("temporary send failure"));
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    await stream.stop();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expectPreviewSend(api, "Hello");
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

    expectPreviewSend(api, "Hello", {
      message_thread_id: 42,
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    });
  });

  it("materializes message previews using rendered HTML text", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      renderText: (text) => ({
        text: text.replace("**bold**", "<b>bold</b>"),
        parseMode: "HTML",
      }),
    });

    stream.update("**bold**");
    await stream.flush();
    const materializedId = await stream.materialize?.();

    expect(materializedId).toBe(17);
    expect(api.sendMessage).toHaveBeenCalledWith(123, "<b>bold</b>", {
      parse_mode: "HTML",
      message_thread_id: 42,
    });
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
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
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
  });

  it("deletes message preview on clear after finalization", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.stop();
    await stream.clear();

    expectPreviewSend(api, "Hello", { message_thread_id: 42 });
    expectPreviewEdit(api, "Hello again");
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
  });

  it("creates new message after forceNewMessage is called", async () => {
    const { api, stream } = createForceNewMessageHarness();

    // First message
    stream.update("Hello");
    await stream.flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Normal edit (same message)
    stream.update("Hello edited");
    await stream.flush();
    expectPreviewEdit(api, "Hello edited");

    // Force new message (e.g. after thinking block ends)
    stream.forceNewMessage();
    stream.update("After thinking");
    await stream.flush();

    // Should have sent a second new message, not edited the first
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 2, "After thinking");
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

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 2, "Next preview");
  });

  it("sends first update immediately after forceNewMessage within throttle window", async () => {
    vi.useFakeTimers();
    try {
      const { api, stream } = createForceNewMessageHarness({ throttleMs: 1000 });

      stream.update("Hello");
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

      stream.update("Hello edited");
      expect(api.editMessageText).not.toHaveBeenCalled();

      stream.forceNewMessage();
      stream.update("Second message");
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
      expectNthPreviewSend(api, 2, "Second message");
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
    api.sendMessage.mockReturnValueOnce(firstSend).mockResolvedValueOnce({ message_id: 42 });
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, { onSupersededPreview });

    stream.update("Message A partial");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

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
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 2, "Message B partial");
    expect(api.editMessageText).not.toHaveBeenCalledWith(123, 17, "Message B partial");
  });

  it("marks sendMayHaveLanded after an ambiguous first preview send failure", async () => {
    const api = createMockDraftApi();
    api.sendMessage.mockRejectedValueOnce(new Error("timeout after Telegram accepted send"));
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(stream.sendMayHaveLanded?.()).toBe(true);
  });

  async function expectSendMayHaveLandedStateAfterFirstFailure(error: Error, expected: boolean) {
    const api = createMockDraftApi();
    api.sendMessage.mockRejectedValueOnce(error);
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(stream.sendMayHaveLanded?.()).toBe(expected);
  }

  it("retries pre-connect first preview send failures instead of stopping", async () => {
    const api = createMockDraftApi();
    api.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
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
    api.editMessageText.mockRejectedValueOnce(
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

    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, "Hello more");
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries the preview edit after a transient network failure", async () => {
    const api = createMockDraftApi();
    api.editMessageText.mockRejectedValueOnce(
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

    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, "Hello again");
    expect(stream.lastDeliveredText?.()).toBe("Hello again");
  });

  it("suspends preview edits for retry_after during flood control", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockDraftApi();
      api.editMessageText.mockRejectedValueOnce(
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
      expect(api.editMessageText).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1100);
      await stream.flush();

      expect(api.editMessageText).toHaveBeenCalledTimes(2);
      expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, "Hello more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the preview after repeated retryable edit failures", async () => {
    const api = createMockDraftApi();
    api.editMessageText.mockRejectedValue(
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

    expect(api.editMessageText).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith("telegram stream preview failed: read ECONNRESET");
  });

  it("supports rendered previews with HTML parse mode", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      renderText: (text) => ({ text: `<i>${text}</i>`, parseMode: "HTML" }),
    });

    stream.update("hello");
    await stream.flush();
    expect(api.sendMessage).toHaveBeenCalledWith(123, "<i>hello</i>", {
      parse_mode: "HTML",
    });

    stream.update("hello again");
    await stream.flush();
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "<i>hello again</i>", {
      parse_mode: "HTML",
    });
  });

  it("sends caller-provided rich previews through standard text transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api);

    stream.updatePreview({
      text: "Shelling\n\n`🛠️ Exec`",
      richMessage: {
        html: "<b>Shelling</b>\n<b>🛠️ Exec</b>",
        skip_entity_detection: true,
      },
    });
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "<b>Shelling</b>\n<b>🛠️ Exec</b>", {
      parse_mode: "HTML",
    });
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();

    stream.updatePreview({
      text: "Shelling\n\n`🛠️ Exec`\n• _Checking files_",
      richMessage: {
        html: "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<i>Checking files</i>",
        skip_entity_detection: true,
      },
    });
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledWith(
      123,
      17,
      "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<i>Checking files</i>",
      { parse_mode: "HTML" },
    );
    expect(api.raw.editMessageText).not.toHaveBeenCalled();
  });

  it("sends marked progress rich previews through HTML text transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api);

    stream.updatePreview({
      text: "Shelling\n\n🛠️ Exec",
      richMessage: {
        html: "<b>Shelling</b><br><b>🛠️ Exec</b>",
        skip_entity_detection: true,
      },
    });
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "<b>Shelling</b>\n<b>🛠️ Exec</b>", {
      parse_mode: "HTML",
    });
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();

    stream.updatePreview({
      text: "Shelling\n\n🛠️ Exec\n• Checking files",
      richMessage: {
        html: "<b>Shelling</b><br><b>🛠️ Exec</b><br><b>Update</b> <code>Checking files</code>",
        skip_entity_detection: true,
      },
    });
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledWith(
      123,
      17,
      "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<b>Update</b> <code>Checking files</code>",
      { parse_mode: "HTML" },
    );
    expect(api.raw.editMessageText).not.toHaveBeenCalled();
  });

  it("falls back to plain preview text when rich preview HTML parsing fails", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("can't parse entities: unsupported tag"))
      .mockResolvedValueOnce({ message_id: 17 });
    const stream = createDraftStream(api);

    stream.updatePreview({
      text: "Shelling\n\n🛠️ Exec",
      richMessage: {
        html: "<b>Shelling</b>\n<b>🛠️ Exec</b>",
        skip_entity_detection: true,
      },
    });
    await stream.flush();

    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 123, "<b>Shelling</b>\n<b>🛠️ Exec</b>", {
      parse_mode: "HTML",
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "Shelling\n\n🛠️ Exec", {});
  });

  it("uses rich send and edit for previews when explicitly enabled", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { richMessages: true });

    stream.updatePreview({
      text: "Plan",
      richMessage: { html: "<h2>Plan</h2><table><tr><td>A</td></tr></table>" },
    });
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: { html: "<h2>Plan</h2><table><tr><td>A</td></tr></table>" },
    });
    expect(api.sendMessage).not.toHaveBeenCalled();

    stream.updatePreview({
      text: "Plan updated",
      richMessage: { html: "<h2>Plan updated</h2><table><tr><td>B</td></tr></table>" },
    });
    await stream.flush();

    expect(api.raw.editMessageText).toHaveBeenCalledWith({
      chat_id: 123,
      message_id: 17,
      rich_message: { html: "<h2>Plan updated</h2><table><tr><td>B</td></tr></table>" },
    });
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("skips rich entity detection for draft text with provider-prefixed email addresses", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { richMessages: true });
    const oauthProfileText =
      "OAuth profile: openai:keshavbotagent@gmail.com (keshavbotagent@gmail.com)";

    stream.update(oauthProfileText);
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: {
        html: oauthProfileText,
        skip_entity_detection: true,
      },
    });
  });

  it("keeps rich preview html out of plain preview gating", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { richMessages: true, minInitialChars: 10 });

    stream.updatePreview({
      text: "Plan",
      richMessage: { html: "<h2>Plan</h2><table><tr><td>A</td></tr></table>" },
    });
    await stream.flush();

    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("clamps rich previews to the block limit", async () => {
    const api = createMockDraftApi();
    const text = Array.from({ length: 501 }, (_, index) => `paragraph ${index}`).join("\n\n");
    const stream = createDraftStream(api, { richMessages: true });

    stream.update(text);
    await stream.flush();

    const calls = api.raw.sendRichMessage.mock.calls as unknown[][];
    const params = calls[0]?.[0] as { rich_message?: TelegramInputRichMessage } | undefined;
    const richMessage = params?.rich_message;
    expect(richMessage?.html).toContain("paragraph 499");
    expect(richMessage?.html).not.toContain("paragraph 500");
  });

  it("clamps rendered previews to the text-message limit", async () => {
    const api = createMockDraftApi();
    const text = `# Long\n\n${"rich line\n".repeat(600)}`;
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      renderText: (value) => ({ text: value }),
    });

    stream.update(text);
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const sentText = requireSendMessageCallText(api, 0);
    expect(sentText.length).toBeLessThanOrEqual(4000);
    expect(sentText.startsWith("# Long\n\nrich line")).toBe(true);
  });

  it("keeps non-final overflow in one editable preview", async () => {
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, { maxChars: 20, onSupersededPreview });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expectNthPreviewSend(api, 1, "Hello world");
    expectPreviewEdit(api, "Hello world foo bar");
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

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expectPreviewEdit(api, "Hello world foo bar");
    expect(onSupersededPreview).not.toHaveBeenCalled();
  });

  it("continues in a new message when a final rendered preview crosses maxChars", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 });
    const stream = createDraftStream(api, { maxChars: 20 });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.stop();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 1, "Hello world");
    expectNthPreviewSend(api, 2, "foo bar baz qux");
  });

  it("clamps a first oversized non-final preview", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { maxChars: 10 });

    stream.update("1234567890ABCDEFGHIJ");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expectNthPreviewSend(api, 1, "1234567890");
    expect(stream.lastDeliveredText?.()).toBe("1234567890");
  });

  it("does not split surrogate pairs when clamping a first oversized non-final preview", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { maxChars: 10 });

    stream.update("123456789😀tail");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const sentText = requireSendMessageCallText(api, 0);
    expect(sentText).toBe("123456789");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sentText)).toBe(false);
    expect(stream.lastDeliveredText?.()).toBe("123456789");
  });

  it("finalizes overflow that was hidden by a clamped non-final preview", async () => {
    const api = createMockDraftApi();
    api.sendMessage
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

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 1, "1234567890");
    expectNthPreviewSend(api, 2, "ABCDEFGHIJ");
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
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 })
      .mockResolvedValueOnce({ message_id: 43 });
    const stream = createDraftStream(api, { maxChars: 10 });

    stream.update("1234567890ABCDEFGHIJKLMNOPQRST");
    await stream.flush();
    await stream.stop();

    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    expectNthPreviewSend(api, 1, "1234567890");
    expectNthPreviewSend(api, 2, "ABCDEFGHIJ");
    expectNthPreviewSend(api, 3, "KLMNOPQRST");
    expect(stream.lastDeliveredText?.()).toBe("1234567890ABCDEFGHIJKLMNOPQRST");
  });

  it("retains final overflow preview pages", async () => {
    const api = createMockDraftApi();
    api.sendMessage
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
        parseMode: "HTML",
      }),
      warn,
    });

    stream.update("short raw text");
    await stream.flush();

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
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

      expectPreviewSend(api, "Y");
    });

    it("sends immediately on stop() with short sentence", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Ok.");
      await stream.stop();
      await stream.flush();

      expectPreviewSend(api, "Ok.");
    });
  });

  describe("minInitialChars threshold", () => {
    it("does not send first message below threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Processing");
      await stream.flush();

      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("does not send a first message when discard() supersedes a short partial", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Processing");
      await stream.discard?.();
      await stream.flush();

      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(api.editMessageText).not.toHaveBeenCalled();
    });

    it("sends first message when reaching threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request..");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalled();
    });

    it("works with longer text above threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request, please wait a moment");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalled();
    });
  });

  describe("subsequent updates after first message", () => {
    it("edits normally after first message is sent", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request..");
      await stream.flush();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);

      stream.update("I am processing your request.. and summarizing");
      await stream.flush();

      expect(api.editMessageText).toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("default behavior without debounce params", () => {
    it("sends plain preview text immediately without minInitialChars set", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
      });

      stream.update("Hi");
      await stream.flush();

      expectPreviewSend(api, "Hi");
    });
  });
});
