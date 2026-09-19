import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  emitToolStart,
  createContext,
  createDraftStream,
  createSequencedDraftStream,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchTelegramMessage,
  dispatchWithContext,
  editMessageTelegram,
  emitTelegramMessageSentHooks,
  expectDeliverRepliesParams,
  expectRecordFields,
  loadSessionStore,
  mockCallArg,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  recordOutboundMessageForPromptContext,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage draft-finalization", () => {
  it("does not drop any long-final text after a generic lane rotation", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await emitToolStart(replyOptions, { name: "exec", phase: "start", toolCallId: "exec-1" });
        await dispatcherOptions.deliver(
          { text: "A".repeat(4000) + "B".repeat(4000) },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      textLimit: 4000,
    });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "A".repeat(4000) + "B".repeat(4000),
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
  });

  it("does not suppress text-only blocks as delivered when answer draft is inactive", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "forced block" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "final text" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial", block: { enabled: true } },
      } satisfies Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"],
    });

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("forced block");
  });

  it("does not suppress text-only blocks after a tool-progress draft", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await emitToolStart(replyOptions, { name: "exec", phase: "start", toolCallId: "exec-1" });
        await dispatcherOptions.deliver({ text: "block after progress" }, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(mockCallArg(answerDraftStream.updatePreview).text).toContain("Exec");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("block after progress");
  });

  it("does not suppress button-bearing blocks after answer streaming starts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial answer" });
        await dispatcherOptions.deliver(
          { text: "choose now", channelData: { telegram: { buttons } } },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith("choose now");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), { buttons });
  });

  it("keeps DM Web App buttons when finalizing the streamed preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Opening the app" });
        await dispatcherOptions.deliver(
          {
            text: "Open the app",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    {
                      label: "Launch",
                      action: { type: "web-app", url: "https://example.com/app" },
                    },
                  ],
                },
              ],
            },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith(
      "Open the app",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "Launch", web_app: { url: "https://example.com/app" } }]],
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps the native status table on the finalized streamed preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Gateway status as plain text",
          presentationTextMode: "fallback",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Status",
                headers: ["Key", "Value"],
                rows: [["Gateway", "running"]],
                rowHeaderColumnIndex: 0,
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
    });

    // The streamed final renders the portable table island; the authored
    // fallback text alone would silently drop the native table.
    const finalUpdate = answerDraftStream.update.mock.calls.at(-1)?.[0] as string;
    expect(finalUpdate).toContain("<table><caption>Status</caption>");
    expect(finalUpdate).toContain("<td>running</td>");
    expect(finalUpdate).not.toBe("Gateway status as plain text");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps the dropped-control label when a fallback final mixes a table with an unencodable control", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Gateway status as plain text",
          presentationTextMode: "fallback",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Status",
                headers: ["Key", "Value"],
                rows: [["Gateway", "running"]],
                rowHeaderColumnIndex: 0,
              },
              {
                type: "buttons",
                buttons: [{ label: "Copy manually", value: "x".repeat(65) }],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
    });

    // Native table renders while the dropped control keeps its text fallback;
    // filtering every interactive block would erase the only visible label.
    const finalUpdate = answerDraftStream.update.mock.calls.at(-1)?.[0] as string;
    expect(finalUpdate).toContain("<table><caption>Status</caption>");
    expect(finalUpdate).toContain("- Copy manually");
    expect(finalUpdate).not.toBe("Gateway status as plain text");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps the dropped legacy-control label when a fallback final mixes a table with a legacy interactive control", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Gateway status as plain text",
          presentationTextMode: "fallback",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Status",
                headers: ["Key", "Value"],
                rows: [["Gateway", "running"]],
                rowHeaderColumnIndex: 0,
              },
            ],
          },
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Copy manually", value: "x".repeat(65) }],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
    });

    // Dispatch appends the dropped legacy-control label to the recovered text;
    // the presentation-only finalization must re-collect it, not erase it.
    const finalUpdate = answerDraftStream.update.mock.calls.at(-1)?.[0] as string;
    expect(finalUpdate).toContain("<table><caption>Status</caption>");
    expect(finalUpdate).toContain("- Copy manually");
    expect(finalUpdate).not.toBe("Gateway status as plain text");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps the group web-app label when a fallback final mixes a table with a web-app control", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Gateway status as plain text",
          presentationTextMode: "fallback",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Status",
                headers: ["Key", "Value"],
                rows: [["Gateway", "running"]],
                rowHeaderColumnIndex: 0,
              },
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Launch",
                    action: { type: "web-app", url: "https://example.com/app" },
                  },
                ],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        chatId: -1001234,
        isGroup: true,
        msg: {
          chat: { id: -1001234, type: "supergroup" },
          message_id: 456,
          message_thread_id: 777,
        } as TelegramMessageContext["msg"],
        threadSpec: { id: 777, scope: "forum" },
      }),
      streamMode: "partial",
      telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
    });

    // Web App buttons are unavailable in groups, so the final text keeps the
    // control's fallback label next to the rendered native table.
    const finalUpdate = answerDraftStream.update.mock.calls.at(-1)?.[0] as string;
    expect(finalUpdate).toContain("<table><caption>Status</caption>");
    expect(finalUpdate).toContain("Launch: https://example.com/app");
    expect(finalUpdate).not.toBe("Gateway status as plain text");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("renders dropped controls in the finalized streamed preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Preparing controls" });
        await dispatcherOptions.deliver(
          {
            text: "Choose",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [{ label: "Copy manually", value: "x".repeat(65) }],
                },
              ],
            },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith(
      "Choose\n\n- Copy manually",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps mixed controls intact through buffered finalization", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "stream" } });
    deliverReplies
      .mockResolvedValueOnce({ delivered: false })
      .mockResolvedValueOnce({ delivered: true });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>first attempt</think>", isReasoning: true },
        { kind: "block" },
      );
      await dispatcherOptions.deliver(
        {
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  { label: "Retry", value: "retry" },
                  { label: "Copy manually", value: "x".repeat(65) },
                ],
              },
            ],
          },
        },
        { kind: "final" },
      );
      await dispatcherOptions.deliver(
        { text: "<think>second attempt</think>", isReasoning: true },
        { kind: "block" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "- Copy manually",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "Retry", callback_data: "retry" }]],
    });
    const fallbackReplies = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(fallbackReplies).not.toContain("- Copy manually");
  });

  it("finalizes an ordinary block-only draft when no final follows", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "block-only answer" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("block-only answer");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(emitTelegramMessageSentHooks).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
      content: "block-only answer",
      messageId: 2001,
    });
  });

  it("does not emit a terminal when a finalized preview may have landed without an id", async () => {
    const { answerDraftStream } = setupDraftStreams();
    answerDraftStream.sendMayHaveLanded.mockReturnValue(true);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "uncertain final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(emitTelegramMessageSentHooks).not.toHaveBeenCalled();
  });

  it("delivers a block-only answer when a native quote disables the draft stream", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "quoted block-only answer", replyToId: "9001" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          ReplyToIsQuote: true,
          ReplyToId: "9001",
          ReplyToQuoteText: "quoted source",
        } as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    const delivery = expectDeliverRepliesParams({});
    expectRecordFields((delivery.replies as Array<unknown>)[0], {
      text: "quoted block-only answer",
      replyToId: "9001",
    });
  });

  it("cleans up the draft after terminal block delivery throws", async () => {
    const { answerDraftStream } = setupDraftStreams();
    deliverReplies.mockRejectedValueOnce(new Error("terminal send failed"));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "block-only answer" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.clear).toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
  });

  it("finalizes a duplicate text-only block when no final follows", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-block-only",
      text: "partial answer",
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial answer" });
        await dispatcherOptions.deliver(
          { text: "partial answer" },
          { kind: "block", assistantMessageIndex: 0 },
        );
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      context,
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
      content: "partial answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      text: "partial answer",
      messageId: 2001,
      promptContextProjection: {
        transcriptMessageId: "assistant-block-only",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("keeps a delayed earlier identical block markerless when a later block rotates it", async () => {
    const answerDraftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => createDraftStream());
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-identical-second",
      text: "OK",
      timestamp: Date.now() + 2_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.({ text: "OK" }, { assistantMessageIndex: 0 });
        await replyOptions?.onBlockReplyQueued?.({ text: "OK" }, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(
          { text: "OK" },
          { kind: "block", assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver(
          { text: "OK" },
          { kind: "block", assistantMessageIndex: 1 },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context, streamMode: "partial" });

    expect(readLatestAssistantTextByIdentity).not.toHaveBeenCalled();
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(1);
    const firstBlockRecord = mockCallArg(recordOutboundMessageForPromptContext);
    expectRecordFields(firstBlockRecord, { text: "OK", messageId: 2001 });
    expect(firstBlockRecord).not.toHaveProperty("promptContextProjection");
  });

  it("materializes a pending duplicate text-only block before finalizing it", async () => {
    const { answerDraftStream } = setupDraftStreams();
    answerDraftStream.stop.mockImplementation(async () => {
      answerDraftStream.setMessageId(2001);
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "pending answer" });
        await dispatcherOptions.deliver({ text: "pending answer" }, { kind: "block" });
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
      content: "pending answer",
      messageId: 2001,
    });
  });
});
