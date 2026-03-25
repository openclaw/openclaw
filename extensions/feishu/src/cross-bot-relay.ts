/**
 * Cross-bot relay: when one bot sends a message to a group chat,
 * construct a synthetic inbound event and dispatch it to other bot
 * accounts monitoring the same group.
 *
 * This works around Feishu's platform limitation where bot messages
 * do not trigger im.message.receive_v1 events for other bots.
 */
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "../runtime-api.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";

// --- Account registry ---
// Each monitoring account registers itself so the relay can dispatch to it.

type RegisteredAccount = {
  accountId: string;
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  botOpenId?: string;
  botName?: string;
};

const registeredAccounts = new Map<string, RegisteredAccount>();

export function registerRelayAccount(account: RegisteredAccount): void {
  registeredAccounts.set(account.accountId, account);
}

export function unregisterRelayAccount(accountId: string): void {
  registeredAccounts.delete(accountId);
}

// --- Relay dispatch ---

// Track message IDs currently being relayed to prevent re-entry.
// When Bot A's outbound triggers relay → Bot B processes → Bot B replies →
// Bot B's outbound triggers relay → we must not re-relay to Bot A in the
// same chain. We use a Set of "synthetic message IDs" that are in-flight.
const activeRelayMessageIds = new Set<string>();

export type RelayOutboundParams = {
  /** Account ID of the bot that sent the message */
  senderAccountId: string;
  /** Chat ID (group) where the message was sent */
  chatId: string;
  /** The text content that was sent */
  text: string;
  /** Message ID returned by Feishu API after sending */
  messageId?: string;
  /** Thread/topic ID for topic group messages (root_id in Feishu events) */
  threadId?: string;
  /** Bot's open_id (sender identity) */
  senderBotOpenId?: string;
  /** Bot's display name */
  senderBotName?: string;
};

export async function relayOutboundToOtherBots(params: RelayOutboundParams): Promise<void> {
  const { senderAccountId, chatId, text, messageId, threadId, senderBotOpenId, senderBotName } =
    params;

  // Only relay to group chats
  if (!chatId) return;

  // Use the real message ID for replies to work, but track with relay prefix for dedup
  const syntheticMessageId = messageId
    ? `relay:${messageId}`
    : `relay:${senderAccountId}:${Date.now()}`;
  // The actual message_id in the event uses the REAL id so reply_to works with Feishu API
  const eventMessageId = messageId || `relay:${senderAccountId}:${Date.now()}`;

  // Prevent re-entry: if this message is already being relayed, skip
  if (activeRelayMessageIds.has(syntheticMessageId)) return;

  // Extract mentioned names from <at user_id="xxx">name</at> tags in the text
  const mentionedNames = new Set<string>();
  const atPattern = /<at\s+user_id="[^"]+">([^<]+)<\/at>/g;
  let match: RegExpExecArray | null;
  while ((match = atPattern.exec(text)) !== null) {
    mentionedNames.add(match[1].trim().toLowerCase());
  }

  // Filter targets: match mentioned names against registered bot names (case-insensitive)
  const allOtherAccounts = Array.from(registeredAccounts.values()).filter(
    (account) => account.accountId !== senderAccountId,
  );
  // Only relay to explicitly mentioned bots — no fallback broadcast
  if (mentionedNames.size === 0) return;
  const targets = allOtherAccounts.filter((account) => {
    const name = account.botName?.trim()?.toLowerCase();
    return name ? mentionedNames.has(name) : false;
  });

  if (targets.length === 0) return;

  activeRelayMessageIds.add(syntheticMessageId);

  try {
    const dispatches = targets.map(async (target) => {
      // Build synthetic event per target, including a mention of the target bot
      // so it passes requireMention checks in group chats.
      const targetBotOpenId = target.botOpenId?.trim();
      const mentions = targetBotOpenId
        ? [
            {
              key: `@_user_relay_${target.accountId}`,
              id: { open_id: targetBotOpenId },
              name: target.botName ?? target.accountId,
            },
          ]
        : undefined;

      const syntheticEvent: FeishuMessageEvent = {
        sender: {
          sender_id: {
            open_id: senderBotOpenId || `bot:${senderAccountId}`,
          },
          sender_type: "bot",
        },
        message: {
          message_id: eventMessageId,
          chat_id: chatId,
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text }),
          create_time: String(Date.now()),
          mentions,
          // Preserve thread/topic metadata so relay messages stay in the correct topic
          ...(threadId ? { root_id: threadId, thread_id: threadId } : {}),
        },
      };
      const log = target.runtime?.log ?? console.log;
      try {
        log(
          `feishu[${target.accountId}]: cross-bot relay from ${senderAccountId}, ` +
            `chat=${chatId}, msgId=${syntheticMessageId}`,
        );
        await handleFeishuMessage({
          cfg: target.cfg,
          event: syntheticEvent,
          botOpenId: target.botOpenId,
          botName: target.botName,
          runtime: target.runtime,
          chatHistories: target.chatHistories,
          accountId: target.accountId,
        });
      } catch (err) {
        log(`feishu[${target.accountId}]: cross-bot relay dispatch failed: ${String(err)}`);
      }
    });

    await Promise.allSettled(dispatches);
  } finally {
    // Clean up after a delay to handle any late re-entry attempts
    setTimeout(() => {
      activeRelayMessageIds.delete(syntheticMessageId);
    }, 120_000);
  }
}
