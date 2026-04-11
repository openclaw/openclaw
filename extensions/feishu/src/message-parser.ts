/**
 * Lightweight message parsing module extracted from bot.ts to break a circular
 * module initialization dependency.
 *
 * Problem:  monitor.account.ts imported parseFeishuMessageEvent from bot.ts.
 *           bot.ts pulls in a heavy dependency tree (bot-content -> post ->
 *           comment-shared -> openclaw/plugin-sdk/text-runtime, plus policy,
 *           reply-dispatcher, dedup, etc.).  When the bundler (tsdown/esbuild)
 *           inlines these into a single output chunk the initialization order
 *           of the shared utility bindings can violate the Temporal Dead Zone,
 *           producing:
 *
 *               ReferenceError: Cannot access 'utils_1' before initialization
 *
 *           The error manifests only when a bot is @-mentioned in a Feishu
 *           group chat with multi-agent configuration because that code path
 *           is the first to exercise the full import graph at runtime.
 *
 * Solution: Keep parseFeishuMessageEvent in this small, shallow module so
 *           monitor.account.ts and sequential-key.ts can import it without
 *           dragging in the entire bot.ts dependency tree.  bot.ts re-exports
 *           it for backward compatibility.
 *
 * Fixes: https://github.com/openclaw/openclaw/issues/64783
 */

import {
  checkBotMentioned,
  normalizeMentions,
  parseMessageContent,
} from "./bot-content.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { extractMentionTargets, isMentionForwardRequest } from "./mention.js";
import type { FeishuMessageContext } from "./types.js";

/**
 * Parse a raw Feishu message event into a normalized context object.
 *
 * This is intentionally placed in its own module so that callers that only
 * need parsing (e.g. monitor.account.ts, sequential-key.ts) do not have to
 * statically import the heavyweight bot.ts module and its transitive deps.
 */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
  _botName?: string,
): FeishuMessageContext {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const hasAnyMention = (event.message.mentions?.length ?? 0) > 0;
  // Strip the bot's own mention so slash commands like @Bot /help retain
  // the leading /. This applies in both p2p *and* group contexts — the
  // mentionedBot flag already captures whether the bot was addressed, so
  // keeping the mention tag in content only breaks command detection (#35994).
  // Non-bot mentions (e.g. mention-forward targets) are still normalized to <at> tags.
  const content = normalizeMentions(rawContent, event.message.mentions, botOpenId);
  const senderOpenId = event.sender.sender_id.open_id?.trim();
  const senderUserId = event.sender.sender_id.user_id?.trim();
  const senderFallbackId = senderOpenId || senderUserId || "";

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: senderUserId || senderOpenId || "",
    // Keep the historical field name, but fall back to user_id when open_id is unavailable
    // (common in some mobile app deliveries).
    senderOpenId: senderFallbackId,
    chatType: event.message.chat_type,
    mentionedBot,
    hasAnyMention,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    threadId: event.message.thread_id || undefined,
    content,
    contentType: event.message.message_type,
  };

  // Detect mention forward request: message mentions bot + at least one other user
  if (isMentionForwardRequest(event, botOpenId)) {
    const mentionTargets = extractMentionTargets(event, botOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
    }
  }

  return ctx;
}
