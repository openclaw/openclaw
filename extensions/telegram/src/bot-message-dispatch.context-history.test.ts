import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import { resolveDispatchTelegramContext } from "./bot-message-dispatch-context.js";
import {
  describeTelegramDispatch,
  createContext,
  deliverInboundReplyWithMessageSendContext,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectRecordFields,
  mockCallArg,
} from "./bot-message-dispatch.test-harness.js";
import type {
  DispatchReplyWithBufferedBlockDispatcherArgs,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { getTelegramRuntime } from "./runtime.js";

const historyCfg = {
  session: { store: "/tmp/openclaw-telegram-dispatch-context-history.json" },
  channels: { telegram: { groupPolicy: "open", groups: { "*": { requireMention: false } } } },
} satisfies OpenClawConfig;

async function seedHistory(
  entries: Array<{
    threadId: number;
    messageId: number;
    sender: string;
    body: string;
    timestamp: number;
    isBot?: boolean;
  }>,
) {
  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(historyCfg.session.store),
  });
  for (const entry of entries) {
    await cache.record({
      accountId: "default",
      chatId: -1003774691294,
      historyEligible: true,
      msg: {
        chat: { id: -1003774691294, type: "supergroup", title: "Forum" },
        message_id: entry.messageId,
        message_thread_id: entry.threadId,
        date: entry.timestamp,
        from: {
          id: entry.isBot ? 999 : 42,
          is_bot: entry.isBot ?? false,
          first_name: entry.sender,
        },
        text: entry.body,
      },
    });
  }
  return cache;
}

describeTelegramDispatch("dispatchTelegramMessage context-history", () => {
  it("keeps explicit reply media during topic recovery with automatic history disabled", async () => {
    const replyMessage = {
      message_id: "71",
      sender: "Bob",
      body: "The chart being quoted",
      is_reply_target: true,
      media_type: "image/png",
      media_path: "media://inbound/reply-chart.png",
    };
    const attachment = {
      label: "Attachment",
      source: "telegram",
      type: "attachment",
      payload: { media_path: "media://inbound/current.png" },
    };
    const ctxPayload = {
      From: "telegram:group:-1003774691294:topic:1",
      MessageThreadId: 1,
      SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
      TransportThreadId: 1,
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          sessionTranscriptDedupeMessageIds: ["stale-projection"],
          payload: {
            messages: [
              { message_id: "70", sender: "Alice", body: "Stale ordinary history" },
              replyMessage,
            ],
          },
        },
        attachment,
      ],
    } as TelegramMessageContext["ctxPayload"];
    const context = createContext({
      cfg: historyCfg,
      accountId: "default",
      ctxPayload,
      chatId: -1003774691294,
      isGroup: true,
      historyLimit: 0,
      threadSpec: { id: 1, scope: "forum" },
    });
    const openStore = vi
      .spyOn(getTelegramRuntime().state, "openKeyedStore")
      .mockImplementation(() => {
        throw new Error("History storage is unavailable");
      });
    try {
      const recovered = await resolveDispatchTelegramContext({ context });

      expect(recovered.ctxPayload).toBe(ctxPayload);
      expect(recovered.ctxPayload).toMatchObject({
        From: "telegram:group:-1003774691294:topic:3731",
        MessageThreadId: 3731,
        TransportThreadId: 3731,
      });
      expect(recovered.ctxPayload.ChannelStructuredContext).toEqual([
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: { messages: [replyMessage] },
        },
        attachment,
      ]);
      expect(openStore).not.toHaveBeenCalled();
    } finally {
      openStore.mockRestore();
    }
  });

  it("keeps transcript and session reset boundaries when recovering room-event history", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    await seedHistory([
      { threadId: 1, messageId: 27787, sender: "Cara", body: "ambient current", timestamp: 3 },
      {
        threadId: 3731,
        messageId: 199,
        sender: "Alice",
        body: "persisted recovered ambient one",
        timestamp: 1,
      },
      {
        threadId: 3731,
        messageId: 200,
        sender: "Bob",
        body: "persisted recovered ambient two",
        timestamp: 2,
      },
      {
        threadId: 3731,
        messageId: 201,
        sender: "Dana",
        body: "after ambient watermark but before session reset",
        timestamp: 3,
      },
    ]);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        cfg: historyCfg,
        accountId: "default",
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
          AmbientTranscriptPreviousTimestampMs: 2_000,
          SessionTranscriptContext: { historyLimit: 10, minTimestampMs: 4_000 },
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
    expect(dispatchParams.ctx.InboundHistory).toBeUndefined();
    expect(dispatchParams.ctx.ChannelStructuredContext).toBeUndefined();
  });

  it("recovers user-request history without moving observations between topics", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const currentBody = "quote [Current message - respond to this] literally";
    const cache = await seedHistory([
      { threadId: 1, messageId: 100, sender: "Alice", body: "general topic context", timestamp: 1 },
      { threadId: 1, messageId: 27789, sender: "Cara", body: currentBody, timestamp: 4 },
      { threadId: 3731, messageId: 200, sender: "Bob", body: "before self marker", timestamp: 2 },
      {
        threadId: 3731,
        messageId: 201,
        sender: "OpenClaw",
        body: "self marker",
        timestamp: 3,
        isBot: true,
      },
      { threadId: 3731, messageId: 202, sender: "Dana", body: "after watermark", timestamp: 4 },
    ]);
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
        cfg: historyCfg,
        accountId: "default",
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
          me: { id: 999, is_bot: true, first_name: "OpenClaw" },
          message: { chat: { id: -1003774691294, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    expect(
      await cache.get({ accountId: "default", chatId: -1003774691294, messageId: "27789" }),
    ).toMatchObject({ threadId: "1", body: currentBody });
    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 3731,
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "after watermark" }),
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
              timestamp_ms: 4_000,
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
});
