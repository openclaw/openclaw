import { createHash } from "node:crypto";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getLineRuntime } from "./runtime.js";

// LINE's webhook reports a quoted message's id but never its author, so the only
// way to recognize our own message is to remember what we sent. The ids are kept
// in memory and in plugin state, so a quote of a message sent before a gateway
// restart still counts as an address. Both copies are bounded.
const RECENT_SENT_LIMIT = 500;

// The bound is per account, not shared: LINE runs several configured accounts in
// one process, and a busy account must not evict a quiet one's ids or the quiet
// bot silently stops treating quotes of itself as being addressed. The registry
// only grows with configured accounts that have actually sent something.
const recentSentByAccount = new Map<string, ReturnType<typeof createDedupeCache>>();

// The persisted copy belongs to the LINE bot itself, not to the config account
// name: an account id re-pointed at another channel must not inherit the previous
// bot's messages. Startup learns the bot's user id from the bot info probe; while
// it is unknown, sends stay memory-only, which is the behavior before persistence.
const botUserIdByAccount = new Map<string, string>();

function recentSentFor(accountId: string): ReturnType<typeof createDedupeCache> {
  const existing = recentSentByAccount.get(accountId);
  if (existing) {
    return existing;
  }
  const created = createDedupeCache({ ttlMs: 0, maxSize: RECENT_SENT_LIMIT });
  recentSentByAccount.set(accountId, created);
  return created;
}

export function rememberLineBotUserId(accountId: string, botUserId: string | undefined): void {
  const trimmed = botUserId?.trim();
  const previous = botUserIdByAccount.get(accountId);
  if (!trimmed) {
    botUserIdByAccount.delete(accountId);
    return;
  }
  if (previous && previous !== trimmed) {
    // The account now speaks for another bot; its remembered ids are not this bot's.
    recentSentByAccount.delete(accountId);
  }
  botUserIdByAccount.set(accountId, trimmed);
}

// One bounded namespace per bot keeps the per-account eviction on disk. The user
// id is hashed because namespaces only allow a safe path segment.
function openPersistedSentFor(
  botUserId: string | undefined,
): PluginStateKeyedStore<true> | undefined {
  if (!botUserId) {
    return undefined;
  }
  try {
    const botKey = createHash("sha256").update(botUserId, "utf8").digest("hex").slice(0, 24);
    return getLineRuntime().state.openKeyedStore<true>({
      namespace: `sent-messages.${botKey}`,
      maxEntries: RECENT_SENT_LIMIT,
    });
  } catch (error) {
    logVerbose(`line: sent-message state unavailable: ${String(error)}`);
    return undefined;
  }
}

export async function recordLineSentMessages(
  accountId: string,
  messageIds: readonly string[],
): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }
  const recentSent = recentSentFor(accountId);
  for (const messageId of messageIds) {
    // check() records the id and re-seats a resent one against eviction.
    recentSent.check(messageId);
  }
  const persisted = openPersistedSentFor(botUserIdByAccount.get(accountId));
  if (!persisted) {
    return;
  }
  try {
    // Sequential writes keep send order, which is the eviction order.
    for (const messageId of messageIds) {
      await persisted.register(messageId, true);
    }
  } catch (error) {
    // Delivery already succeeded; a lost record only costs a later quote match.
    logVerbose(`line: failed to persist sent message ids: ${String(error)}`);
  }
}

// Message ids are unique per account, and LINE only lets a quote reference a
// message from the same conversation, so the account match is the whole check.
// `botUserId` is the webhook's `destination`: the bot that received the quote.
// A webhook recovered from the durable queue can name a bot this account no
// longer speaks for (re-pointed across a restart); such a quote never counts.
export async function quotesLineBotMessage(params: {
  accountId: string;
  botUserId: string | undefined;
  quotedMessageId: string | undefined;
}): Promise<boolean> {
  const { accountId, quotedMessageId } = params;
  if (!quotedMessageId) {
    return false;
  }
  const destination = params.botUserId?.trim();
  const currentBotUserId = botUserIdByAccount.get(accountId);
  if (destination && currentBotUserId && destination !== currentBotUserId) {
    return false;
  }
  if (recentSentByAccount.get(accountId)?.peek(quotedMessageId)) {
    return true;
  }
  // Only the bot this account currently speaks for, confirmed by the webhook.
  const persisted =
    destination === currentBotUserId ? openPersistedSentFor(currentBotUserId) : undefined;
  if (!persisted) {
    return false;
  }
  try {
    return (await persisted.lookup(quotedMessageId)) !== undefined;
  } catch (error) {
    logVerbose(`line: failed to read sent message ids: ${String(error)}`);
    return false;
  }
}
