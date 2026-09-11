// Line plugin module implements quote token behavior.
import type { messagingApi, webhook } from "@line/bot-sdk";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeAccountId, resolveDefaultLineAccountId } from "./accounts.js";
import { normalizeLineMessagingTarget } from "./messaging-target.js";

type Message = messagingApi.Message;
type MessageContent = webhook.MessageEvent["message"];

// LINE addresses a quote by an opaque token that only arrives on the inbound
// event, never by the quoted message's id, so replying to a message means
// remembering the token that came with it.
const QUOTE_TOKEN_LIMIT = 500;

// The bound is per account, matching the outbound message log: LINE runs several
// configured accounts in one process, and a busy account must not evict a quiet
// one's tokens or the quiet bot silently stops quoting.
const quoteTokensByAccount = new Map<string, Map<string, string>>();

// LINE rejects a token used outside the chat that produced it, so the chat is
// part of the key rather than a field a caller could forget to compare.
function quoteTokenKey(chatId: string, messageId: string): string | undefined {
  const chat = normalizeLineMessagingTarget(chatId);
  const message = messageId.trim();
  return chat && message ? `${chat}|${message}` : undefined;
}

/** Reads the quote token LINE attaches to the message kinds a person can quote. */
export function readLineQuoteToken(message: MessageContent): string | undefined {
  return message.type === "text" ||
    message.type === "image" ||
    message.type === "video" ||
    message.type === "sticker"
    ? message.quoteToken
    : undefined;
}

/** Remembers the token an inbound message can later be quoted with. */
export function recordLineQuoteToken(params: {
  accountId: string;
  chatId: string;
  messageId: string;
  quoteToken: string | undefined;
}): void {
  const quoteToken = params.quoteToken;
  if (!quoteToken) {
    return;
  }
  const key = quoteTokenKey(params.chatId, params.messageId);
  if (!key) {
    return;
  }
  const tokens = quoteTokensByAccount.get(params.accountId) ?? new Map<string, string>();
  quoteTokensByAccount.set(params.accountId, tokens);
  // Re-seat a repeated id so the newest token also becomes the newest entry.
  tokens.delete(key);
  tokens.set(key, quoteToken);
  pruneMapToMaxSize(tokens, QUOTE_TOKEN_LIMIT);
}

/** Resolves the token that quotes one message in one chat, if it is still known. */
export function resolveLineQuoteToken(params: {
  cfg: OpenClawConfig;
  accountId: string | null | undefined;
  chatId: string;
  messageId: string | null | undefined;
}): string | undefined {
  const key = params.messageId ? quoteTokenKey(params.chatId, params.messageId) : undefined;
  if (!key) {
    return undefined;
  }
  // A quote token belongs to the channel that issued it, so an unnamed account has
  // to land on the same account the send itself will resolve to.
  const accountId = normalizeAccountId(params.accountId ?? resolveDefaultLineAccountId(params.cfg));
  const quoteToken = quoteTokensByAccount.get(accountId)?.get(key);
  if (!quoteToken) {
    // Every reason a quote is skipped is otherwise invisible, so an operator who
    // turned quoting on and sees none has nowhere to look.
    logVerbose(
      `line: account ${accountId} remembers no quote token for ${key}; sending the reply unquoted`,
    );
  }
  return quoteToken;
}

// The outbound types LINE accepts a quote on. Asking the platform separates the
// two rejections: a type it allows answers "Quote token is invalid" for a bad
// token, while any other type answers "does not support quote message".
const QUOTABLE_OUTBOUND_TYPES: ReadonlySet<Message["type"]> = new Set([
  "text",
  "textV2",
  "sticker",
]);

/** True when LINE lets this message carry the quote for its request. */
export function canCarryLineQuoteToken(message: Pick<Message, "type">): boolean {
  return QUOTABLE_OUTBOUND_TYPES.has(message.type);
}

/**
 * Reports a reply that answered a message but had nothing able to carry the quote.
 *
 * Both delivery paths reach this state, and without a line here the silence reads
 * as "the quote went out" to anyone who saw the resolve step succeed.
 */
export function reportLineQuoteCarrierMissing(chatId: string): void {
  logVerbose(`line: nothing in this reply to ${chatId} can carry a quote; sending it unquoted`);
}

/** Attaches a quote token to the first message in a request that can carry one. */
export function applyLineQuoteToken(
  messages: readonly Message[],
  quoteToken: string | undefined,
): Message[] {
  const target = quoteToken ? messages.findIndex(canCarryLineQuoteToken) : -1;
  return target < 0
    ? [...messages]
    : messages.map((message, index) => (index === target ? { ...message, quoteToken } : message));
}

/**
 * Drops every quote token from a request, or undefined when it carried none.
 *
 * LINE can refuse a whole request for an invalid quote token without naming a
 * field in its error. Offering the same reply without the quote lets delivery
 * recover from that rejection.
 */
export function withoutLineQuoteTokens(messages: readonly Message[]): Message[] | undefined {
  if (!messages.some((message) => "quoteToken" in message)) {
    return undefined;
  }
  // JSON.stringify omits an undefined member, so the field leaves the request
  // without narrowing every message type that never had one.
  return messages.map((message) =>
    "quoteToken" in message ? { ...message, quoteToken: undefined } : message,
  );
}
