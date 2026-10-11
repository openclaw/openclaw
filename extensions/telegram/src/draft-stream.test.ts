// Telegram tests cover draft stream plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraftStream,
  createMockDraftApi,
  type MockSentMessage,
} from "./draft-stream.api.test-helpers.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";
import { buildTelegramRichMarkdownPlan, type TelegramInputRichMessage } from "./rich-message.js";

function createForumDraftStream(api: ReturnType<typeof createMockDraftApi>) {
  return createDraftStream(api, { thread: { id: 99, scope: "forum" } });
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
  it("materializes only the newest lazy partial in a throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const api = createMockDraftApi();
      const stream = createDraftStream(api, { throttleMs: 250 });
      let materializeCount = 0;

      for (let index = 1; index <= 24; index += 1) {
        stream.updateLazy(() => {
          materializeCount += 1;
          return `partial ${index}`;
        });
      }

      expect(materializeCount).toBe(0);
      await vi.advanceTimersByTimeAsync(250);
      expect(materializeCount).toBe(1);
      expectPreviewSend(api, "partial 24");

      vi.setSystemTime(500);
      stream.updateLazy(() => {
        materializeCount += 1;
        return undefined;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(materializeCount).toBe(2);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.editMessageText).not.toHaveBeenCalled();

      stream.updateLazy(() => {
        materializeCount += 1;
        return "visible after empty";
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(materializeCount).toBe(3);
      expectPreviewEdit(api, "visible after empty");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops before another preview when accepted-message validation fails", async () => {
    const api = createMockDraftApi(async () => ({ message_id: 101, message_thread_id: 7 }));
    const validationError = new Error("provider topic mismatch");
    const validateProviderMessage = vi.fn(async () => {
      throw validationError;
    });
    const stream = createDraftStream(api, { validateProviderMessage });

    stream.update("First preview");
    await expect(stream.waitForInFlight()).rejects.toBe(validationError);
    stream.update("Second preview");
    await expect(stream.flush()).rejects.toBe(validationError);

    expect(validateProviderMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("stops accepting updates before awaiting durable provider observation", async () => {
    let resolveObservation: (() => void) | undefined;
    const observation = new Promise<void>((resolve) => {
      resolveObservation = resolve;
    });
    const api = createMockDraftApi();
    const onProviderMessage = vi.fn(() => observation);
    const stream = createDraftStream(api, { onProviderMessage });

    stream.update("Durable preview");
    await stream.flush();
    const stopPromise = stream.stop();
    await vi.waitFor(() => expect(onProviderMessage).toHaveBeenCalledTimes(1));

    stream.update("Late update");
    resolveObservation?.();
    await stopPromise;
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).not.toHaveBeenCalled();
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
    const stream = createDraftStream(api, { thread: { id: 1, scope: "forum" } });

    stream.update("Hello");

    await vi.waitFor(() => expectPreviewSend(api, "Hello"));
  });

  it.each([{ scope: "direct-messages" as const, expected: { direct_messages_topic_id: 42 } }])(
    "does not retry $scope message preview sends without the topic id",
    async ({ scope, expected }) => {
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
      expectPreviewSend(api, "Hello", expected);
      expect(warn).toHaveBeenCalledWith(
        "telegram stream preview failed: 400: Bad Request: message thread not found",
      );
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("retrying without thread")),
      ).toBe(false);
    },
  );

  it("converts <br> joins to newlines before parse_mode=HTML transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      // Progress drafts join rendered lines with <br>; Bot API parse_mode=HTML
      // has no <br> tag, so sending it verbatim 400s every multi-line edit and
      // drops the preview to the unformatted plain fallback.
      renderText: (text) => ({
        text: `<b>Shelling</b><br>🧠 <i>${text}</i>`,
        parseMode: "HTML",
      }),
    });

    stream.update("Thinking");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "<b>Shelling</b>\n🧠 <i>Thinking</i>", {
      parse_mode: "HTML",
    });
  });

  it.each(["send", "edit"] as const)(
    "does not recover a retired preview after a delayed %s receipt",
    async (operation) => {
      const api = createMockDraftApi();
      const stream = createDraftStream(api);
      let resolveReceipt!: (message: MockSentMessage) => void;
      const receipt = new Promise<MockSentMessage>((resolve) => {
        resolveReceipt = resolve;
      });
      if (operation === "edit") {
        stream.update("Initial preview");
        await stream.flush();
        api.editMessageText.mockReturnValueOnce(receipt);
      } else {
        api.sendMessage.mockReturnValueOnce(receipt);
      }

      stream.update("Retired pre-tool preview");
      const pending = stream.flush();
      await vi.waitFor(() =>
        expect(operation === "edit" ? api.editMessageText : api.sendMessage).toHaveBeenCalled(),
      );
      stream.rotateToNewMessageDeferringDelete();
      resolveReceipt({ message_id: 17 });
      await pending;

      // Final-error recovery reads this value; a retired generation cannot supply it.
      expect(stream.lastDeliveredText()).toBe("");
      await stream.stop();
    },
  );

  it.each(["first"] as const)(
    "keeps a settled %s reply target owned when reposition cleanup fails",
    async (replyToMode) => {
      vi.useFakeTimers();
      try {
        const api = createMockDraftApi();
        api.sendMessage
          .mockResolvedValueOnce({ message_id: 17 })
          .mockResolvedValueOnce({ message_id: 42 })
          .mockResolvedValueOnce({ message_id: 43 });
        api.deleteMessage.mockRejectedValueOnce(new Error("delete rejected"));
        const warn = vi.fn();
        const stream = createDraftStream(api, {
          replyToMessageId: 411,
          replyToMode,
          thread: { id: 42, scope: "dm" },
          warn,
        });

        stream.update("Old preview");
        await stream.flush();
        stream.rotateToNewMessageDeferringDelete();
        stream.update("Replacement preview");
        await stream.flush();

        expectNthPreviewSend(api, 2, "Replacement preview", { message_thread_id: 42 });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));

        // The old message remains visible, so later pages must not reuse its
        // single-use reply target after cleanup rejection.
        stream.forceNewMessage();
        stream.update("Later preview");
        await stream.flush();
        expectNthPreviewSend(api, 3, "Later preview", { message_thread_id: 42 });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["first"] as const)(
    "keeps a %s reply target on a reposition-superseded in-flight send until deletion",
    async (replyToMode) => {
      // Red-team F5: rotateToNewMessageDeferringDelete rewinds while a FIRST send is
      // still in flight (no message id yet). The late-landing message is a stale
      // preview to delete — NOT a durable content chunk to retain (that is
      // forceNewMessage's contract). Previously it retained that late send,
      // leaving a ghost bubble.
      vi.useFakeTimers();
      try {
        let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
        const firstSend = new Promise<{ message_id: number }>((resolve) => {
          resolveFirstSend = resolve;
        });
        const api = createMockDraftApi();
        api.sendMessage.mockReturnValueOnce(firstSend).mockResolvedValueOnce({ message_id: 42 });
        const onSupersededPreview = vi.fn();
        const onProviderMessage = vi.fn();
        const stream = createDraftStream(api, {
          onRetainedPage: onSupersededPreview,
          onProviderMessage,
          replyToMessageId: 411,
          replyToMode,
          thread: { id: 42, scope: "dm" },
        });

        stream.update("Message A partial");
        await vi.advanceTimersByTimeAsync(0);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expectNthPreviewSend(api, 1, "Message A partial", {
          message_thread_id: 42,
          reply_parameters: {
            message_id: 411,
            allow_sending_without_reply: true,
          },
        });

        // Reposition while the first send is still in flight, then stream on.
        stream.rotateToNewMessageDeferringDelete();
        stream.update("Message B partial");

        resolveFirstSend?.({ message_id: 17 });
        await vi.advanceTimersByTimeAsync(0);
        await stream.flush();

        // The raced first send is NOT retained as a durable chunk...
        expect(onSupersededPreview).not.toHaveBeenCalled();
        expect(onProviderMessage).not.toHaveBeenCalled();
        await stream.stop();
        expect(onProviderMessage).toHaveBeenCalledTimes(1);
        expect(onProviderMessage).toHaveBeenCalledWith(expect.objectContaining({ message_id: 42 }));
        expect(api.deleteMessage).not.toHaveBeenCalled();
        // ...it is deleted deferred, so no orphaned stale bubble is left behind.
        await vi.advanceTimersByTimeAsync(4_000);
        expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        // Until detached deletion succeeds, the stale send still owns the
        // single-use reply and the replacement must omit it.
        expectNthPreviewSend(api, 2, "Message B partial", {
          message_thread_id: 42,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not report a first preview cleared while its send is in flight", async () => {
    vi.useFakeTimers();
    try {
      let resolveSend: ((value: { message_id: number }) => void) | undefined;
      const send = new Promise<{ message_id: number }>((resolve) => {
        resolveSend = resolve;
      });
      const api = createMockDraftApi();
      api.sendMessage.mockReturnValueOnce(send);
      const onProviderMessage = vi.fn();
      const stream = createDraftStream(api, { onProviderMessage });

      stream.update("Temporary preview");
      await vi.advanceTimersByTimeAsync(0);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);

      const clearPromise = stream.clear();
      resolveSend?.({ message_id: 17 });
      await vi.advanceTimersByTimeAsync(0);
      await clearPromise;

      expect(onProviderMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a rotated preview accepted while clear waits for its in-flight send", async () => {
    vi.useFakeTimers();
    try {
      let resolveSend!: (message: MockSentMessage) => void;
      const send = new Promise<MockSentMessage>((resolve) => {
        resolveSend = resolve;
      });
      const api = createMockDraftApi();
      api.sendMessage.mockReturnValueOnce(send);
      const stream = createDraftStream(api);

      stream.update("Temporary preview");
      await vi.advanceTimersByTimeAsync(0);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      stream.rotateToNewMessageDeferringDelete();
      const clearPromise = stream.clear();
      resolveSend({ message_id: 17 });
      await clearPromise;

      await vi.advanceTimersByTimeAsync(3_999);
      expect(api.deleteMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.deleteMessage).toHaveBeenCalledExactlyOnceWith(123, 17);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["first"] as const)(
    "keeps an in-flight %s reply target owned when reposition cleanup fails",
    async (replyToMode) => {
      vi.useFakeTimers();
      try {
        let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
        const firstSend = new Promise<{ message_id: number }>((resolve) => {
          resolveFirstSend = resolve;
        });
        const api = createMockDraftApi();
        api.sendMessage
          .mockReturnValueOnce(firstSend)
          .mockResolvedValueOnce({ message_id: 42 })
          .mockResolvedValueOnce({ message_id: 43 });
        api.deleteMessage.mockRejectedValueOnce(new Error("delete rejected"));
        const warn = vi.fn();
        const stream = createDraftStream(api, {
          replyToMessageId: 411,
          replyToMode,
          thread: { id: 42, scope: "dm" },
          warn,
        });

        stream.update("Message A partial");
        await vi.advanceTimersByTimeAsync(0);
        stream.rotateToNewMessageDeferringDelete();
        stream.update("Message B partial");
        resolveFirstSend?.({ message_id: 17 });
        await vi.advanceTimersByTimeAsync(0);
        await stream.flush();

        expectNthPreviewSend(api, 2, "Message B partial", { message_thread_id: 42 });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));

        stream.forceNewMessage();
        stream.update("Message C partial");
        await stream.flush();
        expectNthPreviewSend(api, 3, "Message C partial", { message_thread_id: 42 });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a rotated preview until Telegram accepts its replacement", async () => {
    vi.useFakeTimers();
    try {
      let resolveReplacement!: (message: MockSentMessage) => void;
      const replacement = new Promise<MockSentMessage>((resolve) => {
        resolveReplacement = resolve;
      });
      const api = createMockDraftApi();
      api.sendMessage.mockResolvedValueOnce({ message_id: 17 }).mockReturnValueOnce(replacement);
      const stream = createDraftStream(api);

      stream.update("Answer preview");
      await stream.flush();
      stream.rotateToNewMessageDeferringDelete();
      stream.update("Replacement");
      await vi.advanceTimersByTimeAsync(0);
      expect(api.sendMessage).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.deleteMessage).not.toHaveBeenCalled();

      resolveReplacement({ message_id: 42 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a rotated preview visible when its replacement send fails", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockDraftApi();
      api.sendMessage
        .mockResolvedValueOnce({ message_id: 17 })
        .mockRejectedValueOnce(new Error("replacement rejected"));
      const stream = createDraftStream(api, { warn: vi.fn() });

      stream.update("Answer preview");
      await stream.flush();
      stream.rotateToNewMessageDeferringDelete();
      stream.update("Replacement");
      await stream.flush();
      await stream.stop();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
      expect(stream.sendMayHaveLanded()).toBe(true);
      expect(api.deleteMessage).not.toHaveBeenCalled();

      await stream.clear();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
    } finally {
      vi.useRealTimers();
    }
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
    const stream = createDraftStream(api, {
      onRetainedPage: onSupersededPreview,
      replyToMessageId: 411,
      replyToMode: "first",
      thread: { id: 42, scope: "dm" },
    });

    stream.update("Message A partial");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expectNthPreviewSend(api, 1, "Message A partial", {
      message_thread_id: 42,
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    });

    stream.forceNewMessage();
    stream.update("Message B partial");

    resolveFirstSend?.({ message_id: 17 });
    await stream.flush();

    expect(onSupersededPreview).toHaveBeenCalledTimes(1);
    const [supersededPreview] = onSupersededPreview.mock.calls.at(0) ?? [];
    expect(supersededPreview).toMatchObject({
      messageId: 17,
      textSnapshot: "Message A partial",
    });
    expect(Number.isFinite(supersededPreview.visibleSinceMs)).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 2, "Message B partial", { message_thread_id: 42 });
    expect(api.editMessageText).not.toHaveBeenCalledWith(123, 17, "Message B partial");
  });

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

  it("keeps the newest preview pending when the account limiter skips a flooded edit", async () => {
    const api = createMockDraftApi();
    const warn = vi.fn();
    const flooded = () =>
      Object.assign(new Error("429: Too Many Requests: retry after 5"), {
        error_code: 429,
        parameters: { retry_after: 5 },
      });
    api.editMessageText
      .mockRejectedValueOnce(flooded())
      .mockRejectedValueOnce(flooded())
      .mockRejectedValueOnce(flooded())
      .mockRejectedValueOnce(flooded());
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    for (const text of ["one", "two", "three", "four"]) {
      stream.update(`Hello ${text}`);
      await stream.flush();
    }
    stream.update("Hello final");
    await stream.stop();

    // Skipped previews do not spend the failure budget that stops the stream.
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, "Hello final");
    expect(stream.lastDeliveredText()).toBe("Hello final");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("preview failed"));
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

  it("falls back to plain preview text when HTML parsing fails", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("can't parse entities: unsupported tag"))
      .mockResolvedValueOnce({ message_id: 17 });
    const stream = createDraftStream(api);

    stream.updatePreview({
      text: "<b>Shelling &lt;&amp;&gt;</b>\n<b>Exec</b>",
      parseMode: "HTML",
    });
    await stream.flush();

    expect(api.sendMessage).toHaveBeenNthCalledWith(
      1,
      123,
      "<b>Shelling &lt;&amp;&gt;</b>\n<b>Exec</b>",
      { parse_mode: "HTML" },
    );
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "Shelling <&>\nExec", {});
    expect(stream.currentMessageSnapshot?.()).toEqual({
      text: "Shelling <&>\nExec",
      sourceText: "Shelling &lt;&amp;&gt;\nExec",
      sourceTextMode: "html",
    });

    api.editMessageText
      .mockRejectedValueOnce(new Error("can't parse entities: unsupported tag"))
      .mockResolvedValueOnce(true);
    stream.updatePreview({
      text: "<b>Done &lt;&amp;&gt;</b>",
      parseMode: "HTML",
    });
    await stream.flush();

    expect(api.editMessageText).toHaveBeenNthCalledWith(1, 123, 17, "<b>Done &lt;&amp;&gt;</b>", {
      parse_mode: "HTML",
    });
    expect(api.editMessageText).toHaveBeenNthCalledWith(2, 123, 17, "Done <&>");
    expect(stream.currentMessageSnapshot?.()).toEqual({
      text: "Done <&>",
      sourceText: "Done &lt;&amp;&gt;",
      sourceTextMode: "html",
    });
  });

  it("falls back to plain preview text when an HTML edit renders empty", async () => {
    const api = createMockDraftApi();
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.updatePreview({ text: "<b>Working</b>", parseMode: "HTML" });
    await stream.flush();

    api.editMessageText
      .mockRejectedValueOnce(new Error("400: Bad Request: message text is empty"))
      .mockResolvedValueOnce(true);
    stream.updatePreview({ text: "<b>Done &lt;&amp;&gt;</b>", parseMode: "HTML" });
    await stream.flush();

    expect(api.editMessageText).toHaveBeenNthCalledWith(1, 123, 17, "<b>Done &lt;&amp;&gt;</b>", {
      parse_mode: "HTML",
    });
    expect(api.editMessageText).toHaveBeenNthCalledWith(2, 123, 17, "Done <&>");
    expect(stream.currentMessageSnapshot?.()).toEqual({
      text: "Done <&>",
      sourceText: "Done &lt;&amp;&gt;",
      sourceTextMode: "html",
    });
    expect(warn).toHaveBeenCalledWith(
      "telegram stream preview edit degrade=plain-fallback:empty-content: 400: Bad Request: message text is empty",
    );
  });

  it("uses rich send and edit for previews when explicitly enabled", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { richMessages: true });

    stream.update("## Plan\n\n| A |\n| --- |\n| x |\n\nOAuth profile: openai:fixture@example.com");
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    const first = api.raw.sendRichMessage.mock.calls[0]?.[0] as {
      rich_message?: TelegramInputRichMessage;
    };
    expect(first?.rich_message?.blocks?.some((block) => block.type === "heading")).toBe(true);
    expect(first?.rich_message?.blocks?.some((block) => block.type === "table")).toBe(true);
    expect(first?.rich_message?.skip_entity_detection).toBe(true);
    expect(api.sendMessage).not.toHaveBeenCalled();

    stream.update("## Plan updated\n\n| B |\n| --- |\n| y |");
    await stream.flush();

    expect(api.raw.editMessageText).toHaveBeenCalledTimes(1);
    const edit = api.raw.editMessageText.mock.calls[0]?.[0] as {
      rich_message?: TelegramInputRichMessage;
    };
    expect(edit?.rich_message?.blocks?.some((block) => block.type === "heading")).toBe(true);
    expect(api.editMessageText).not.toHaveBeenCalled();
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
    const plain = (richMessage?.blocks ?? [])
      .map((block) =>
        block.type === "paragraph" && typeof block.text === "string" ? block.text : "",
      )
      .join("\n");
    expect(plain).toContain("paragraph 499");
    expect(plain).not.toContain("paragraph 500");
  });

  it("paginates rendered fenced code without losing code context", async () => {
    const text = [
      "```ts",
      "  const one = 1;",
      "  const two = 2;",
      "  return one + two;",
      "```",
    ].join("\n");
    const pagePattern = /^<pre><code class="language-ts">[\s\S]*<\/code><\/pre>$/u;
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 55,
      onRetainedPage: onSupersededPreview,
      renderText: (value) => ({
        text: renderTelegramHtmlText(value),
        parseMode: "HTML",
      }),
    });

    stream.update(text);
    await stream.stop();

    const pages = api.sendMessage.mock.calls.map((call) => call[1]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => pagePattern.test(page))).toBe(true);
    const visiblePages = pages.map(telegramHtmlToPlainTextFallback);
    expect(visiblePages.join("")).toBe("  const one = 1;\n  const two = 2;\n  return one + two;\n");
    expect(onSupersededPreview.mock.calls.map(([page]) => page.textSnapshot)).toEqual(
      visiblePages.slice(0, -1),
    );
    expect(stream.currentMessageSnapshot?.()).toMatchObject({
      text: visiblePages.at(-1),
      sourceText: pages.at(-1),
      sourceTextMode: "html",
    });
  });

  it("paginates one rendered rich-code plan without reparsing Markdown tails", async () => {
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const text = [
      "```ts",
      "  const one = 1;",
      "  const two = 2;",
      "  return one + two;",
      "```",
    ].join("\n");
    const stream = createDraftStream(api, {
      // Plain code body is shorter than HTML-wrapped rich text; keep the limit
      // under the pre body so pagination still splits across messages.
      maxChars: 30,
      richMessages: true,
      onRetainedPage: onSupersededPreview,
    });

    stream.update(text);
    await stream.stop();

    const pages = api.raw.sendRichMessage.mock.calls.map((call) => {
      const params = call[0] as { rich_message?: TelegramInputRichMessage };
      return params.rich_message?.blocks ?? [];
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((blocks) => blocks.every((block) => block.type === "pre"))).toBe(true);
    expect(
      pages.every((blocks) =>
        blocks.some((block) => block.type === "pre" && block.language === "ts"),
      ),
    ).toBe(true);
    expect(
      pages
        .flatMap((blocks) => blocks.map((block) => (block.type === "pre" ? block.text : "")))
        .join(""),
    ).toBe("  const one = 1;\n  const two = 2;\n  return one + two;");
    expect(onSupersededPreview).toHaveBeenCalledTimes(pages.length - 1);
  });

  it("preserves whitespace-only code content across rich pages", async () => {
    const api = createMockDraftApi();
    const text = ["```", " ".repeat(80), "```"].join("\n");
    const stream = createDraftStream(api, { maxChars: 40, richMessages: true });

    stream.update(text);
    await stream.stop();

    const pages = api.raw.sendRichMessage.mock.calls.map((call) => {
      const params = call[0] as { rich_message?: TelegramInputRichMessage };
      return params.rich_message?.blocks ?? [];
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((blocks) => blocks.every((block) => block.type === "pre"))).toBe(true);
    expect(
      pages
        .flatMap((blocks) => blocks.map((block) => (block.type === "pre" ? block.text : "")))
        .join("")
        .replace(/\n$/u, ""),
    ).toBe(" ".repeat(80));
  });

  it("keeps a single-use reply target until the first draft send is accepted", async () => {
    let rejected = false;
    let nextMessageId = 17;
    const api = createMockDraftApi();
    api.sendMessage.mockImplementation(async () => {
      if (!rejected) {
        rejected = true;
        throw Object.assign(new Error("429: retry after 1"), {
          error_code: 429,
          parameters: { retry_after: 1 },
        });
      }
      return { message_id: nextMessageId++ };
    });
    const stream = createDraftStream(api, {
      maxChars: 10,
      replyToMessageId: 411,
      replyToMode: "first",
    });

    stream.update("1234567890ABCDEFGHIJ");
    await stream.stop();
    await stream.stop();

    const replyParams = {
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    };
    expectNthPreviewSend(api, 1, "1234567890", replyParams);
    expectNthPreviewSend(api, 2, "1234567890", replyParams);
    expectNthPreviewSend(api, 3, "ABCDEFGHIJ");
  });

  it("resumes final pagination at the first rejected page", async () => {
    vi.useFakeTimers();
    try {
      const accepted: string[] = [];
      const attempts: string[] = [];
      let rejectedSecondPage = false;
      let nextMessageId = 17;
      const api = createMockDraftApi();
      api.sendMessage.mockImplementation(async (_chatId, text) => {
        const page = text;
        attempts.push(page);
        if (page === "ABCDEFGHIJ" && !rejectedSecondPage) {
          rejectedSecondPage = true;
          throw Object.assign(new Error("429: retry after 1"), {
            error_code: 429,
            parameters: { retry_after: 1 },
          });
        }
        accepted.push(page);
        return { message_id: nextMessageId++ };
      });
      const onSupersededPreview = vi.fn();
      const stream = createDraftStream(api, {
        maxChars: 10,
        onRetainedPage: onSupersededPreview,
      });

      stream.update("1234567890ABCDEFGHIJKLMNOPQRST");
      await stream.stop();

      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ", "ABCDEFGHIJ", "KLMNOPQRST"]);
      expect(accepted).toEqual(["1234567890", "ABCDEFGHIJ", "KLMNOPQRST"]);
      expect(onSupersededPreview.mock.calls.map(([page]) => page.textSnapshot)).toEqual([
        "1234567890",
        "ABCDEFGHIJ",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["accepted", "retryable rejection"])(
    "does not let a superseded %s final page freeze the replacement stream",
    async (outcome) => {
      let settleSecondPage: (() => void) | undefined;
      const secondPage = new Promise<{ message_id: number }>((resolve, reject) => {
        settleSecondPage = () => {
          if (outcome === "accepted") {
            resolve({ message_id: 42 });
          } else {
            reject(
              Object.assign(new Error("429: retry after 1"), {
                error_code: 429,
                parameters: { retry_after: 1 },
              }),
            );
          }
        };
      });
      const api = createMockDraftApi();
      api.sendMessage
        .mockResolvedValueOnce({ message_id: 17 })
        .mockReturnValueOnce(secondPage)
        .mockResolvedValueOnce({ message_id: 43 });
      const stream = createDraftStream(api, { maxChars: 10 });

      stream.update("1234567890ABCDEFGHIJ");
      await stream.flush();
      const stopPromise = stream.stop();
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
      stream.forceNewMessage();
      stream.update("replaced");
      settleSecondPage?.();
      await stopPromise;
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledTimes(3);
      expectNthPreviewSend(api, 3, "replaced");
      expect(stream.messageId()).toBe(43);
    },
  );
});

describe("draft stream initial message debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("sends short complete rich progress and resumes after clear", async () => {
    const api = createMockDraftApi(async () => ({ message_id: 42 }));
    const stream = createDraftStream(api, { richMessages: true, minInitialChars: 30 });
    const progress = (text: string) => ({
      text,
      complete: true as const,
      richMessage: buildTelegramRichMarkdownPlan(text).richMessage,
    });
    stream.updatePreview(progress("0/1 complete"));
    await stream.flush();
    expect(api.raw.sendRichMessage).toHaveBeenCalledOnce();
    await stream.clear();
    stream.forceNewMessage();
    stream.update("Hi");
    await stream.flush();
    expect(api.raw.sendRichMessage).toHaveBeenCalledOnce();
    stream.updatePreview(progress("1/1 complete"));
    await stream.flush();
    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
    stream.update("Done");
    await stream.stop();
    expect(api.raw.editMessageText).toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(api.deleteMessage).toHaveBeenCalledOnce();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("Telegram draft link previews", () => {
  it.each([false, true])(
    "suppresses progress link cards through send, edit and stop (rich fallback: %s)",
    async (richMessages) => {
      const api = createMockDraftApi();
      const error = new Error("400: Bad Request: RICH_MESSAGE_URL_INVALID");
      api.raw.sendRichMessage.mockRejectedValue(error);
      api.raw.editMessageText.mockRejectedValue(error);
      const stream = createDraftStream(api, { richMessages });
      const preview = (text: string) =>
        renderTelegramProgressDraftPreview(
          { lines: [text] },
          { richMessages, toolProgress: true, maxLines: 5, maxLineChars: 300 },
        );

      stream.updatePreview(preview("Reading https://example.com"));
      await stream.flush();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        richMessages
          ? "Reading https://example.com"
          : 'Reading <a href="https://example.com">https://example.com</a>',
        expect.objectContaining({
          link_preview_options: { is_disabled: true },
          ...(richMessages ? {} : { parse_mode: "HTML" }),
        }),
      );

      stream.updatePreview(preview("Checking https://example.com"));
      await stream.flush();
      await stream.stop();
      expect(api.editMessageText).toHaveBeenLastCalledWith(
        123,
        17,
        richMessages
          ? "Checking https://example.com"
          : 'Checking <a href="https://example.com">https://example.com</a>',
        expect.objectContaining({
          link_preview_options: { is_disabled: true },
          ...(richMessages ? {} : { parse_mode: "HTML" }),
        }),
      );
    },
  );

  it("restores the answer policy even when only the frame's link policy changes", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api);
    const text = "https://example.com";
    stream.updatePreview({ text, linkPreview: false });
    await stream.flush();
    stream.update(text);
    await stream.flush();
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, text);
  });
});

const replyQuote = {
  text: "Original request",
  position: 0,
  entities: [{ type: "bold", offset: 0, length: 8 }],
};

describe("Telegram preview native quotes", () => {
  it.each([false, true])(
    "retains the accepted preview after quote rejection (rich: %s)",
    async (rich) => {
      const api = createMockDraftApi();
      const send = rich ? api.raw.sendRichMessage : api.sendMessage;
      send.mockRejectedValueOnce(new Error("Bad Request: quote not found"));
      const stream = createDraftStream(api, {
        thread: { id: 99, scope: "forum" },
        replyToMessageId: 7,
        replyToMode: "all",
        replyQuote,
        richMessages: rich,
        renderText: (text) =>
          rich
            ? { text, richMessage: buildTelegramRichMarkdownPlan(text).richMessage }
            : { text, parseMode: "HTML" },
      });
      try {
        stream.update("First");
        await stream.flush();
        stream.update("Final");
        await stream.stop();
        const requests = rich
          ? api.raw.sendRichMessage.mock.calls.map(([params]) => params)
          : api.sendMessage.mock.calls.map((call) => call[2]);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
          message_thread_id: 99,
          reply_parameters: {
            message_id: 7,
            allow_sending_without_reply: true,
            quote: replyQuote.text,
            quote_position: 0,
            quote_entities: replyQuote.entities,
          },
        });
        expect(requests[1]).toMatchObject(
          rich
            ? {
                message_thread_id: 99,
                reply_parameters: { message_id: 7, allow_sending_without_reply: true },
              }
            : {
                message_thread_id: 99,
                reply_to_message_id: 7,
                allow_sending_without_reply: true,
              },
        );
        expect(requests[1]).not.toHaveProperty("reply_parameters.quote");
        if (rich) {
          expect(api.raw.editMessageText).toHaveBeenCalledWith(
            expect.objectContaining({ chat_id: 123, message_id: 17 }),
          );
          expect(api.sendMessage).not.toHaveBeenCalled();
        } else {
          expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Final", {
            parse_mode: "HTML",
          });
        }
        expect(stream.currentMessageSnapshot()).toMatchObject({
          text: "Final",
          replyToMessageId: 7,
        });
        expect(api.deleteMessage).not.toHaveBeenCalled();
      } finally {
        await stream.discard();
      }
    },
  );

  it.each([
    { failure: "quote", retirement: "authorization" },
    { failure: "quote", retirement: "discard" },
    { failure: "format", retirement: "authorization" },
    { failure: "format", retirement: "generation" },
  ])(
    "does not retry $failure after $retirement retires the send",
    async ({ failure, retirement }) => {
      const pending = createDeferred<MockSentMessage>();
      void pending.promise.catch(() => undefined);
      const api = createMockDraftApi();
      api.raw.sendRichMessage.mockImplementationOnce(() => pending.promise);
      let authorized = true;
      const stream = createDraftStream(api, {
        replyToMessageId: 7,
        replyToMode: "all",
        replyQuote,
        richMessages: true,
        renderText: (text) => ({
          text,
          richMessage: buildTelegramRichMarkdownPlan(text).richMessage,
        }),
        warn: vi.fn(),
      });
      let discarding: Promise<void> | undefined;
      const rejection = new Error(
        failure === "quote"
          ? "Bad Request: quote not found"
          : "Bad Request: RICH_MESSAGE_ENTITIES_INVALID",
      );
      try {
        stream.update("Retired answer", {
          assertPlatformSendAuthorized: () => {
            if (!authorized) {
              throw new Error("Send authority revoked");
            }
          },
        });
        await vi.waitFor(() => expect(api.raw.sendRichMessage).toHaveBeenCalledOnce());
        if (retirement === "authorization") {
          authorized = false;
        } else if (retirement === "generation") {
          stream.forceNewMessage();
        } else {
          discarding = stream.discard();
        }
        pending.reject(rejection);
        await stream.waitForInFlight();
        await discarding;
        expect(api.raw.sendRichMessage).toHaveBeenCalledOnce();
        expect(api.sendMessage).not.toHaveBeenCalled();
        if (retirement === "generation") {
          stream.update("Replacement");
          await stream.stop();
          expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(2);
          expect(stream.currentMessageSnapshot()).toMatchObject({ text: "Replacement" });
        }
      } finally {
        pending.reject(rejection);
        await stream.discard();
        await discarding;
      }
    },
  );
});

describe("Telegram preview send authority", () => {
  it("does not apply a failed final's authority to the next generation's lazy preview", async () => {
    const api = createMockDraftApi();
    api.sendMessage.mockResolvedValueOnce({ message_id: 17 }).mockResolvedValueOnce({
      message_id: 42,
    });
    api.editMessageText.mockRejectedValue(new Error("Bad Request: message to edit not found"));
    const stream = createDraftStream(api);
    let authorized = true;
    stream.update("Working");
    await stream.flush();
    stream.update("Final answer", {
      assertPlatformSendAuthorized: () => {
        if (!authorized) {
          throw new Error("Send authority revoked");
        }
      },
    });
    await stream.stop();
    expect(stream.isStopped()).toBe(true);
    authorized = false;

    stream.forceNewMessage();
    stream.updateLazy(() => "Next turn");
    await stream.flush();
    expectNthPreviewSend(api, 2, "Next turn");
    expect(stream.isStopped()).toBe(false);
  });

  it("keeps a final's authority for its resume attempt when a late lazy update is ignored", async () => {
    const api = createMockDraftApi();
    const firstFinalEdit = Promise.withResolvers<never>();
    api.editMessageText.mockReturnValueOnce(firstFinalEdit.promise);
    const stream = createDraftStream(api);
    let authorized = true;
    stream.update("Working");
    await stream.flush();
    stream.update("Final answer", {
      assertPlatformSendAuthorized: () => {
        if (!authorized) {
          throw new Error("Send authority revoked");
        }
      },
    });
    const stopping = stream.stop();
    await vi.waitFor(() => expect(api.editMessageText).toHaveBeenCalledOnce());
    stream.updateLazy(() => "Late partial");
    authorized = false;
    firstFinalEdit.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    await stopping.catch(() => undefined);
    expect(api.editMessageText).toHaveBeenCalledOnce();
  });
});
