import { expect, it, vi } from "vitest";
import { resolveDispatchTelegramContext } from "./bot-message-dispatch-context.js";
import {
  describeTelegramDispatch,
  createBot,
  createContext,
  createPromptContextFixture,
  createDraftStream,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectRecordFields,
  mockCallArg,
} from "./bot-message-dispatch.test-harness.js";
import type {
  DispatchReplyWithBufferedBlockDispatcherArgs,
  TelegramBotDeps,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage context-history", () => {
  it("keeps the host-bound payload object while recovering forum routing", async () => {
    const ctxPayload = {
      From: "telegram:group:-1003774691294:topic:1",
      MessageThreadId: 1,
      SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
      TransportThreadId: 1,
    } as TelegramMessageContext["ctxPayload"];
    const context = createContext({
      ctxPayload,
      chatId: -1003774691294,
      isGroup: true,
      threadSpec: { id: 1, scope: "forum" },
    });

    const recovered = await resolveDispatchTelegramContext({ context });

    expect(recovered.ctxPayload).toBe(ctxPayload);
    expect(recovered.ctxPayload).toMatchObject({
      From: "telegram:group:-1003774691294:topic:3731",
      MessageThreadId: 3731,
      TransportThreadId: 3731,
    });
  });

  it("reselects recovered room-event history without changing native topic observations", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredContext = createPromptContextFixture([
      { sender: "Bob", body: "recovered topic context", timestamp_ms: 3, message_id: "27786" },
    ]);
    const originalContext = structuredClone(recoveredContext);
    const readPromptContext = vi.fn(async () => recoveredContext);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27787",
          MessageThreadId: 1,
          RawBody: "ambient leak",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        readPromptContext,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    expect(readPromptContext).toHaveBeenCalledExactlyOnceWith({ id: 3731, scope: "forum" });
    expect(recoveredContext).toEqual(originalContext);
    const dispatchParams = mockCallArg(
      dispatchReplyWithBufferedBlockDispatcher,
    ) as DispatchReplyWithBufferedBlockDispatcherArgs;
    expect(dispatchParams.ctx).toMatchObject({
      RawBody: "ambient leak",
      MessageSid: "27787",
      InboundHistory: [
        { sender: "Bob", body: "recovered topic context", timestamp: 3, messageId: "27786" },
      ],
    });
    expect(JSON.stringify(dispatchParams.ctx.ChannelStructuredContext)).not.toContain(
      "ambient leak",
    );
  });

  it("omits transcript-owned ambient rows from recovered room-event prompt text", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredContext = createPromptContextFixture([
      {
        sender: "Alice",
        body: "persisted recovered ambient one",
        timestamp_ms: 1,
        message_id: "199",
      },
      {
        sender: "Bob",
        body: "persisted recovered ambient two",
        timestamp_ms: 2,
        message_id: "200",
      },
    ]);
    const originalContext = structuredClone(recoveredContext);
    const readPromptContext = vi.fn(async () => recoveredContext);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          BodyForAgent: "ambient current",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27787",
          MessageThreadId: 1,
          RawBody: "ambient current",
          SenderName: "Cara",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
          AmbientTranscriptPreviousMessageId: "200",
          AmbientTranscriptPreviousTimestampMs: 2,
        } as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
        } as TelegramMessageContext["msg"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        readPromptContext,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const dispatchParams = mockCallArg(
      dispatchReplyWithBufferedBlockDispatcher,
    ) as DispatchReplyWithBufferedBlockDispatcherArgs;
    expect(dispatchParams.ctx).toMatchObject({
      BodyForAgent: "ambient current",
      InboundEventKind: "room_event",
      MessageSid: "27787",
      SenderName: "Cara",
    });
    expect(readPromptContext).toHaveBeenCalledExactlyOnceWith({ id: 3731, scope: "forum" });
    expect(recoveredContext).toEqual(originalContext);
    expect(dispatchParams.ctx.InboundHistory).toBeUndefined();
    expect(dispatchParams.ctx.ChannelStructuredContext).toBeUndefined();
  });

  it("reselects user-request history after the self watermark without changing current text", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const currentBody = "quote [Current message - respond to this] literally";
    const recoveredContext = createPromptContextFixture([
      { sender: "Bob", body: "before self marker", timestamp_ms: 2, message_id: "27784" },
      { sender: "OpenClaw (you)", body: "self marker", timestamp_ms: 3, message_id: "27785" },
      { sender: "Dana", body: "after watermark", timestamp_ms: 4, message_id: "27786" },
    ]);
    const originalContext = structuredClone(recoveredContext);
    const readPromptContext = vi.fn(async () => recoveredContext);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["3731"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "topic final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "user_request",
          Body: currentBody,
          BodyForAgent: currentBody,
          CommandBody: currentBody,
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27789",
          MessageThreadId: 1,
          RawBody: currentBody,
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27789,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -1003774691294, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        readPromptContext,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    expect(readPromptContext).toHaveBeenCalledExactlyOnceWith({ id: 3731, scope: "forum" });
    expect(recoveredContext).toEqual(originalContext);
    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 3731,
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "after watermark", messageId: "27786" }),
    ]);
    expect(outboundCtxPayload).toMatchObject({
      Body: currentBody,
      BodyForAgent: currentBody,
      CommandBody: currentBody,
      RawBody: currentBody,
    });
    expect(outboundCtxPayload.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        label: "Conversation context",
        source: "telegram",
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              body: "after watermark",
              sender: "Dana",
              timestamp_ms: 4,
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(outboundCtxPayload.ChannelStructuredContext)).not.toContain(
      "before self marker",
    );
    expect(JSON.stringify(outboundCtxPayload.ChannelStructuredContext)).not.toContain(
      "self marker",
    );
    expect(JSON.stringify(outboundCtxPayload.ChannelStructuredContext)).not.toContain(currentBody);
  });

  it("keeps retained overflow draft previews", async () => {
    const draftStream = createDraftStream();
    const bot = createBot();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), bot });

    const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
      NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
    >[0];
    streamParams.onRetainedPage?.({
      messageId: 17,
      textSnapshot: "first page",
    });
    expect(bot.api["deleteMessage"]).not.toHaveBeenCalled();
  });
});
