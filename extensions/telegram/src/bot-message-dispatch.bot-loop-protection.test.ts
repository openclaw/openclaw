// Telegram tests cover bot-pair loop protection on the assembled dispatch turn.
import { setTimeout as sleep } from "node:timers/promises";
import { createStatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import { expect, it, vi } from "vitest";
import {
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

// The harness hands the assembled turn to the real core runner, so these cases exercise the
// shared pair guard itself. That guard is process-wide: every case uses its own account id.
// Channel posts reach this path through the real channel_post handler in
// bot.create-telegram-bot.bot-loop-protection.test.ts.
const RECEIVER_BOT_ID = 4242;
const PEER_BOT = { id: 5151, is_bot: true, first_name: "Peer" } as const;
const cfg = {
  channels: {
    defaults: {
      botLoopProtection: { maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60 },
    },
  },
};

type Sender = NonNullable<TelegramMessageContext["msg"]["from"]>;
type Inbound = {
  from: Sender;
  messageId: number;
  /** Receiving account and bot; defaults to the case account and RECEIVER_BOT_ID. */
  to?: { accountId: string; botId: number };
  /** Group chat; omitted means a private chat, whose id is the peer's user id. */
  group?: {
    chatId: number;
    /** Basic group by default; a forum topic implies a forum supergroup. */
    type?: "group" | "supergroup";
    topicId?: number;
    /** Set when Telegram delivers the message as sent on behalf of a chat. */
    senderChat?: { id: number; type: "supergroup" | "channel"; title: string };
    isAutomaticForward?: boolean;
  };
  statusReactionController?: TelegramMessageContext["statusReactionController"];
};

function inboundContext(accountId: string, inbound: Inbound): TelegramMessageContext {
  const to = inbound.to ?? { accountId, botId: RECEIVER_BOT_ID };
  const group = inbound.group;
  const chatId = group?.chatId ?? inbound.from.id;
  const topicId = group?.topicId;
  return createContext({
    primaryCtx: {
      me: { id: to.botId, is_bot: true, first_name: "Receiver", username: "receiver_bot" },
    } as unknown as TelegramMessageContext["primaryCtx"],
    msg: {
      chat: !group
        ? { id: chatId, type: "private" }
        : topicId !== undefined
          ? { id: chatId, type: "supergroup", is_forum: true }
          : { id: chatId, type: group.type ?? "group" },
      message_id: inbound.messageId,
      ...(topicId !== undefined ? { message_thread_id: topicId, is_topic_message: true } : {}),
      ...(group?.senderChat ? { sender_chat: group.senderChat } : {}),
      ...(group?.isAutomaticForward ? { is_automatic_forward: true } : {}),
      date: 1_700_000_000 + inbound.messageId,
      from: inbound.from,
    } as unknown as TelegramMessageContext["msg"],
    chatId,
    ...(group
      ? {
          isGroup: true,
          resolvedThreadId: topicId,
          replyThreadId: topicId,
          threadSpec:
            topicId !== undefined
              ? { id: topicId, scope: "forum" as const }
              : { scope: "none" as const },
        }
      : {}),
    ...(inbound.statusReactionController
      ? { statusReactionController: inbound.statusReactionController }
      : {}),
    route: { accountId: to.accountId } as unknown as TelegramMessageContext["route"],
  });
}

async function dispatchInbound(accountId: string, messages: readonly Inbound[]) {
  const recordCalls: number[] = [];
  for (const inbound of messages) {
    const context = inboundContext(accountId, inbound);
    await expect(dispatchWithContext({ context, cfg })).resolves.toEqual({ kind: "completed" });
    recordCalls.push(vi.mocked(context.turn.recordInboundSession).mock.calls.length);
  }
  return { recordCalls, dispatchCalls: dispatchReplyWithBufferedBlockDispatcher.mock.calls.length };
}

describeTelegramDispatch("dispatchTelegramMessage bot-loop protection", () => {
  it("drops another bot's turn before record and dispatch once the pair exceeds its budget", async () => {
    const result = await dispatchInbound("loop-peer-bot", [
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 2 },
      { from: PEER_BOT, messageId: 3 },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 0], dispatchCalls: 2 });
  });

  it("drops the same way when the peer bot writes as itself in a basic group", async () => {
    const group = { chatId: -5550001 };
    const result = await dispatchInbound("loop-group", [
      { from: PEER_BOT, messageId: 1, group },
      { from: PEER_BOT, messageId: 2, group },
      { from: PEER_BOT, messageId: 3, group },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 0], dispatchCalls: 2 });
  });

  // Bot API: when a message is sent on behalf of a chat, `sender_chat` is set and `from` is a
  // placeholder user kept for backward compatibility, not the author. Model the placeholder
  // as a bot user to show that even then it never counts.
  it.each([
    [
      "an anonymous group admin",
      {
        chatId: -1005550003,
        type: "supergroup",
        senderChat: { id: -1005550003, type: "supergroup", title: "Ops" },
      },
      { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" },
    ],
    [
      "a linked channel's automatic forward",
      {
        chatId: -1005550004,
        type: "supergroup",
        senderChat: { id: -1005550005, type: "channel", title: "Announcements" },
        isAutomaticForward: true,
      },
      { id: 136817688, is_bot: true, first_name: "Channel", username: "Channel_Bot" },
    ],
  ] as const)("never budgets %s, sent on behalf of a chat", async (label, group, from) => {
    const result = await dispatchInbound(`loop-on-behalf-${label}`, [
      { from, messageId: 1, group },
      { from, messageId: 2, group },
      { from, messageId: 3, group },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 1], dispatchCalls: 3 });
  });

  it("restores the status reaction on a dropped turn, so no stall warning follows", async () => {
    const reactions: string[] = [];
    const statusReactionController = createStatusReactionController({
      enabled: true,
      adapter: {
        setReaction: async (emoji: string) => {
          reactions.push(emoji);
        },
      },
      initialEmoji: "initial",
      emojis: { thinking: "thinking", stallSoft: "stall-soft", stallHard: "stall-hard" },
      // The thinking reaction stays debounced for the whole case; the stall timers do not.
      timing: { debounceMs: 60_000, stallSoftMs: 200, stallHardMs: 300 },
    });
    const result = await dispatchInbound("loop-status-reaction", [
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 2 },
      { from: PEER_BOT, messageId: 3, statusReactionController },
    ]);
    await sleep(400);

    expect({ result, reactions }).toEqual({
      result: { recordCalls: [1, 1, 0], dispatchCalls: 2 },
      reactions: ["initial"],
    });
  });

  it("bounds each side of a private bot DM in the receiving account's own budget", async () => {
    // Each bot sees the DM under the other's user id, and each account records only its own
    // inbound, so every inbound on one side lands in one bucket and that side stops at its third.
    const botA = { id: 6161, is_bot: true, first_name: "A" } as const;
    const botB = { id: 6262, is_bot: true, first_name: "B" } as const;
    const toA = { accountId: "loop-dm-a", botId: botA.id };
    const toB = { accountId: "loop-dm-b", botId: botB.id };
    const result = await dispatchInbound("loop-dm", [
      { from: botB, to: toA, messageId: 1 },
      { from: botA, to: toB, messageId: 2 },
      { from: botB, to: toA, messageId: 3 },
      { from: botA, to: toB, messageId: 4 },
      { from: botB, to: toA, messageId: 5 },
      { from: botA, to: toB, messageId: 6 },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 1, 1, 0, 0], dispatchCalls: 4 });
  });

  it("spends one chat budget across forum topics, so topic hopping does not reset it", async () => {
    const group = { chatId: -1005550002 };
    const result = await dispatchInbound("loop-topics", [
      { from: PEER_BOT, messageId: 1, group: { ...group, topicId: 11 } },
      { from: PEER_BOT, messageId: 2, group: { ...group, topicId: 22 } },
      { from: PEER_BOT, messageId: 3, group: { ...group, topicId: 33 } },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 0], dispatchCalls: 2 });
  });

  it("does not spend the budget on a replay of the same Telegram message", async () => {
    const result = await dispatchInbound("loop-replay", [
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 2 },
      { from: PEER_BOT, messageId: 3 },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 1, 1, 0], dispatchCalls: 4 });
  });

  it.each([
    ["a human sender", { id: 7001, is_bot: false, first_name: "Alice" }],
    ["this bot itself", { id: RECEIVER_BOT_ID, is_bot: true, first_name: "Receiver" }],
  ] as const)("never suppresses %s", async (label, from) => {
    const result = await dispatchInbound(`loop-exempt-${label}`, [
      { from, messageId: 1 },
      { from, messageId: 2 },
      { from, messageId: 3 },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 1], dispatchCalls: 3 });
  });
});
