import type { Message } from "grammy/types";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchThroughSharedOwner } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  appendAssistantMirrorMessageByIdentity,
  createBot,
  createContext,
  createDraftStream,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  emitTelegramMessageSentHooks,
  expectDraftStreamParams,
  expectRecordFields,
  loadSessionStore,
  mockCallArg,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  recordOutboundMessageForPromptContext,
  setupDraftStreams,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import type {
  TelegramBotDeps,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";
import type * as TelegramDelivery from "./bot/delivery.replies.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { buildTelegramConversationContext, createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext as recordOutboundMessageForPromptContextActual } from "./outbound-message-context.js";
import { wasSentByBot } from "./sent-message-cache.js";

describeTelegramDispatch("dispatchTelegramMessage delivery-transcript", () => {
  it("keeps the Telegram edit cap for non-block previews regardless of chunk config", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Hello" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      cfg: {
        channels: {
          telegram: { streaming: { preview: { chunk: { maxChars: 600 } } } },
        },
      },
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expectDraftStreamParams({ maxChars: 4000 });
  });

  it("projects retained draft pages and the active tail as one complete sequence", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2100 });
    answerDraftStream.currentMessageSnapshot.mockReturnValue({
      text: "page 2",
      sourceText: "page 2",
    });
    const finalText = "page 0page 1page 2";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-stream-multipart",
      text: finalText,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
        NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
      >[0];
      streamParams.onRetainedPage?.({
        messageId: 2098,
        textSnapshot: "page 0",
      });
      streamParams.onRetainedPage?.({
        messageId: 2099,
        textSnapshot: "page 1",
      });
      await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(
      recordOutboundMessageForPromptContext.mock.calls.map(([record]) => ({
        messageId: record.messageId,
        text: record.text,
        projection: record.promptContextProjection,
      })),
    ).toEqual(
      ["page 0", "page 1", "page 2"].map((text, partIndex) => ({
        messageId: 2098 + partIndex,
        text,
        projection: {
          transcriptMessageId: "assistant-stream-multipart",
          partIndex,
          finalPart: partIndex === 2,
        },
      })),
    );
  });

  it("records streamed final replies into the prompt context cache", async () => {
    const storePath = `/tmp/openclaw-telegram-stream-context-${process.pid}-${Date.now()}.json`;
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext({
      primaryCtx: {
        me: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
        },
      } as TelegramMessageContext["primaryCtx"],
    });
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-stream-2",
      text: "Done already: timeoutSeconds is now 7200s.",
      timestamp: transcriptTimestamp,
    });
    setupDraftStreams({ answerMessageId: 1497 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
        NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
      >[0];
      const providerMessage = {
        chat: { id: 123, type: "private", first_name: "Keshav" },
        message_thread_id: 777,
        message_id: 1497,
        date: 1_779_425_461,
        text: "Initial streamed text",
        from: { id: 999, is_bot: true, first_name: "Telegram Bot Name" },
      } satisfies Message;
      await streamParams.validateProviderMessage?.(providerMessage);
      await streamParams.onProviderMessage?.(providerMessage);
      await dispatcherOptions.deliver(
        { text: "Done already: timeoutSeconds is now 7200s." },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context,
      cfg: { session: { store: storePath } },
      telegramCfg: { name: "Configured Agent" },
      telegramDeps: {
        ...telegramDepsForTest,
        recordOutboundMessageForPromptContext: recordOutboundMessageForPromptContextActual,
      },
    });

    expect(await wasSentByBot("123", 1497, { session: { store: storePath } })).toBe(true);

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: "123",
      threadId: 777,
      msg: {
        chat: { id: 123, type: "private", first_name: "Keshav" },
        message_thread_id: 777,
        message_id: 1521,
        date: 1_779_425_460,
        text: "Did all Amazon crons run fine",
        from: { id: 5185575566, is_bot: false, first_name: "Keshav" },
      },
    });

    const conversationContext = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: "123",
      threadId: 777,
      messageId: "1521",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    const streamedReply = conversationContext.find((entry) => entry.node.messageId === "1497");
    expect(streamedReply?.node).toMatchObject({
      body: "Done already: timeoutSeconds is now 7200s.",
      sender: "Configured Agent (you)",
      senderId: "999",
      sourceMessage: {
        from: {
          id: 999,
          is_bot: true,
          first_name: "Configured Agent (you)",
        },
      },
    });
    expect(streamedReply?.node.timestamp).not.toBe(transcriptTimestamp);
    expect(streamedReply?.node.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: {
        transcriptMessageId: "assistant-stream-2",
        partIndex: 0,
        finalPart: true,
      },
    });
    expect(streamedReply?.node.threadBinding).toEqual({
      kind: "provider-observed-v1",
      threadSpec: { scope: "dm", id: 777 },
    });
  });

  it.each([
    { label: "single message", chunks: ["Final answer"], textLimit: 4096, failLastSend: false },
    {
      label: "multiple chunks",
      chunks: ["chunk-one", "chunk-two"],
      textLimit: 12,
      failLastSend: false,
    },
    {
      label: "failed send and failed cleanup",
      chunks: ["chunk-one", "chunk-two"],
      textLimit: 12,
      failLastSend: true,
    },
  ])(
    "preserves accepted native quote receipts when history finalization fails: $label",
    async ({ chunks, textLimit, failLastSend }) => {
      const actualDelivery = await vi.importActual<typeof TelegramDelivery>(
        "./bot/delivery.replies.js",
      );
      const finalText = chunks.join("\n\n");
      const historyFailure = new Error("retained Telegram history write failed");
      const sendFailure = new Error("synthetic terminal send failure");
      const bot = createBot();
      let nextMessageId = 2801;
      const sendMessage = vi
        .spyOn(bot.api, "sendMessage")
        .mockImplementation(async (_chatId, text) => {
          const messageId = nextMessageId++;
          if (failLastSend && messageId === 2800 + chunks.length) {
            throw sendFailure;
          }
          return {
            message_id: messageId,
            message_thread_id: 777,
            date: 1_779_425_461,
            chat: { id: 123, type: "private", first_name: "Test user" },
            text,
          };
        });
      const context = createContext({
        ctxPayload: {
          SessionKey: "agent:default:telegram:direct:123",
          RawBody: "Explain this quote",
          BodyForAgent: "Explain this quote",
          ReplyToId: "9001",
          ReplyToBody: "quoted slice",
          ReplyToQuoteText: "quoted slice",
          ReplyToIsQuote: true,
        } as TelegramMessageContext["ctxPayload"],
      });
      mockDefaultSessionEntry();
      readLatestAssistantTextByIdentity.mockResolvedValue({
        id: "assistant-native-quote",
        text: finalText,
        timestamp: Date.now() + 1_000,
      });
      let observedError: unknown;
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async (params) =>
        dispatchThroughSharedOwner({
          ...params,
          replyResolver: async () => ({ text: finalText, replyToId: "9001" }),
          dispatcherOptions: {
            ...params.dispatcherOptions,
            onError: async (error, info) => {
              observedError = error;
              await params.dispatcherOptions.onError?.(error, info);
            },
          },
        }),
      );
      const finalHistoryWrites: number[] = [];

      await expect(
        dispatchWithContext({
          bot,
          context,
          replyToMode: "all",
          textLimit,
          telegramDeps: {
            ...telegramDepsForTest,
            deliverReplies: actualDelivery.deliverReplies,
            deliverStructuredReplies: actualDelivery.deliverStructuredReplies,
            recordOutboundMessageForPromptContext: async (params) => {
              if (params.promptContextProjection?.finalPart === !failLastSend) {
                finalHistoryWrites.push(params.messageId);
                throw historyFailure;
              }
              return await recordOutboundMessageForPromptContextActual(params);
            },
          },
        }),
      ).resolves.toEqual({ kind: "completed" });

      const acceptedCount = chunks.length - Number(failLastSend);
      expect(finalHistoryWrites).toEqual([2800 + acceptedCount]);
      expect(sendMessage).toHaveBeenCalledTimes(chunks.length);
      expect(sendMessage.mock.calls.map(([, text]) => text).join("")).toBe(finalText);
      for (const call of sendMessage.mock.calls) {
        expect(call[2]?.reply_parameters).toMatchObject({
          message_id: 9001,
          quote: "quoted slice",
        });
      }
      expect(isChannelPartialDeliveryError(observedError)).toBe(true);
      if (!isChannelPartialDeliveryError(observedError)) {
        throw observedError;
      }
      const messageIds = Array.from({ length: acceptedCount }, (_, index) => String(2801 + index));
      if (failLastSend) {
        const cleanupFailure = observedError.cause;
        expect(cleanupFailure).toBeInstanceOf(AggregateError);
        if (!(cleanupFailure instanceof AggregateError)) {
          throw cleanupFailure;
        }
        expect(cleanupFailure.errors).toContain(historyFailure);
        let acceptedFailure: unknown = cleanupFailure.errors[0];
        while (isChannelPartialDeliveryError(acceptedFailure)) {
          acceptedFailure = acceptedFailure.cause;
        }
        expect(acceptedFailure).toBe(sendFailure);
      } else {
        expect(observedError.cause).toBe(historyFailure);
      }
      expect(observedError.deliveryResult).toMatchObject({
        visibleReplySent: true,
        messageIds,
        receipt: {
          primaryPlatformMessageId: "2801",
          platformMessageIds: messageIds,
          threadId: "777",
          parts: messageIds.map((platformMessageId) => ({
            platformMessageId,
            threadId: "777",
          })),
        },
      });
    },
  );

  it("suppresses text-only tool payloads delivered after the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "failed command output", isError: true },
        { kind: "tool" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "Final answer",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("materializes chart-only finals into the active answer preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          presentation: {
            title: "FY25 outlook",
            blocks: [
              {
                type: "chart",
                chartType: "pie",
                title: "Revenue mix",
                segments: [
                  { label: "Product", value: 60 },
                  { label: "Services", value: 40 },
                ],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "FY25 outlook\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it("materializes table-only finals into the active answer preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          presentation: {
            title: "FY25 outlook",
            blocks: [
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "Stage", "ARR"],
                rows: [
                  ["Acme", "Won", 125000],
                  ["Globex", "Review", 82000],
                ],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "FY25 outlook\n\nPipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it("appends chart data to final text before active preview finalization", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Quarterly results",
          presentation: {
            title: "FY25 outlook",
            blocks: [
              { type: "text", text: "Do not duplicate this block" },
              {
                type: "chart",
                chartType: "bar",
                title: "Revenue",
                categories: ["Q1", "Q2"],
                series: [{ name: "USD", values: [12, 18] }],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "Quarterly results\n\nFY25 outlook\n\nDo not duplicate this block\n\nRevenue (bar chart)\n- USD: Q1: 12; Q2: 18",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it("mirrors preview-finalized finals into the session transcript", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    const mirrorCall = expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      idempotencyKey: expect.stringContaining("telegram-final:agent:default:telegram:direct:123:"),
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
    expect(mirrorCall.deliveryMirror).toEqual({
      kind: "channel-final",
      sourceMessageId: mirrorCall.idempotencyKey,
    });
  });

  it("keeps same-millisecond transcript mirror keys distinct per inbound message", async () => {
    createTelegramDraftStream.mockImplementation(() => createDraftStream(2001));
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    const firstContext = createContext({
      ctxPayload: {
        MessageSid: "456",
        SessionKey: "agent:default:telegram:direct:123",
      } as TelegramMessageContext["ctxPayload"],
    });
    const secondContext = createContext({
      ctxPayload: {
        MessageSid: "457",
        SessionKey: "agent:default:telegram:direct:123",
      } as TelegramMessageContext["ctxPayload"],
      msg: { message_id: 457 } as TelegramMessageContext["msg"],
    });
    mockDefaultSessionEntry();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    try {
      await dispatchWithContext({ context: firstContext });
      await dispatchWithContext({ context: secondContext });
    } finally {
      dateNow.mockRestore();
    }

    const firstMirrorCall = expectRecordFields(
      mockCallArg(appendAssistantMirrorMessageByIdentity),
      {
        idempotencyKey: expect.stringContaining(
          "telegram-final:agent:default:telegram:direct:123:123:456:",
        ),
      },
    );
    const secondMirrorCall = expectRecordFields(
      mockCallArg(appendAssistantMirrorMessageByIdentity, 1),
      {
        idempotencyKey: expect.stringContaining(
          "telegram-final:agent:default:telegram:direct:123:123:457:",
        ),
      },
    );
    expect(firstMirrorCall.idempotencyKey).not.toBe(secondMirrorCall.idempotencyKey);
  });

  it("skips transcript mirroring when the scoped session is absent", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({});
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
  });

  it("does not mirror non-final tool progress into the session transcript", async () => {
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    deliverReplies.mockImplementation(
      async (params: {
        replies?: Array<{ text?: string }>;
        transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        const text = params.replies
          ?.map((reply) => reply.text)
          .filter(Boolean)
          .join("\n\n");
        await params.transcriptMirror?.({ text });
        return { delivered: true };
      },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "🛠️ tool progress" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context,
      streamMode: "partial",
      cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
      telegramCfg: { streaming: { mode: "partial", preview: { toolProgress: true } } },
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(deliverReplies, 0), {
      transcriptMirror: undefined,
    });
    expect(typeof mockCallArg(deliverReplies, 1).transcriptMirror).toBe("function");
    expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
  });

  it("mirrors a legitimate repeat after a new user turn instead of skipping it", async () => {
    const repeatedText = "Final answer";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({ text: repeatedText, timestamp: 1 });
    deliverReplies.mockImplementation(
      async (params: {
        replies?: Array<{ text?: string }>;
        transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        const text = params.replies
          ?.map((reply) => reply.text)
          .filter(Boolean)
          .join("\n\n");
        await params.transcriptMirror?.({ text });
        return { delivered: true };
      },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: repeatedText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      idempotencyKey: expect.stringContaining("telegram-final:agent:default:telegram:direct:123:"),
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: repeatedText,
    });
  });

  it("mirrors the longer streamed preview when final text is truncated", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: fullAnswer });
        await dispatcherOptions.deliver({ text: truncatedFinal }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalledWith(fullAnswer);
    expect(answerDraftStream.update).not.toHaveBeenCalledWith(truncatedFinal);
    expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
      content: fullAnswer,
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: fullAnswer,
    });
  });

  it("treats session rebound mirror skips as non-fatal", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    appendAssistantMirrorMessageByIdentity.mockResolvedValueOnce({
      ok: false,
      code: "session-rebound",
      reason: "session rebound for sessionKey: agent:default:telegram:direct:123",
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
  });
});
