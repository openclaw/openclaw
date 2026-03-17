import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound
} from "../../../../src/channels/inbound-debounce-policy.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import { dispatchPreparedSlackMessage } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";
const APP_MENTION_RETRY_TTL_MS = 6e4;
function resolveSlackSenderId(message) {
  return message.user ?? message.bot_id ?? null;
}
function isSlackDirectMessageChannel(channelId) {
  return channelId.startsWith("D");
}
function isTopLevelSlackMessage(message) {
  return !message.thread_ts && !message.parent_user_id;
}
function buildTopLevelSlackConversationKey(message, accountId) {
  if (!isTopLevelSlackMessage(message)) {
    return null;
  }
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  return `slack:${accountId}:${message.channel}:${senderId}`;
}
function shouldDebounceSlackMessage(message, cfg) {
  const text = message.text ?? "";
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return shouldDebounceTextInbound({
    text: textForCommandDetection,
    cfg,
    hasMedia: Boolean(message.files && message.files.length > 0)
  });
}
function buildSeenMessageKey(channelId, ts) {
  if (!channelId || !ts) {
    return null;
  }
  return `${channelId}:${ts}`;
}
function buildSlackDebounceKey(message, accountId) {
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  const messageTs = message.ts ?? message.event_ts;
  const threadKey = message.thread_ts ? `${message.channel}:${message.thread_ts}` : message.parent_user_id && messageTs ? `${message.channel}:maybe-thread:${messageTs}` : messageTs && !isSlackDirectMessageChannel(message.channel) ? `${message.channel}:${messageTs}` : message.channel;
  return `slack:${accountId}:${threadKey}:${senderId}`;
}
function createSlackMessageHandler(params) {
  const { ctx, account, trackEvent } = params;
  const { debounceMs, debouncer } = createChannelInboundDebouncer({
    cfg: ctx.cfg,
    channel: "slack",
    buildKey: (entry) => buildSlackDebounceKey(entry.message, ctx.accountId),
    shouldDebounce: (entry) => shouldDebounceSlackMessage(entry.message, ctx.cfg),
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId);
      const topLevelConversationKey = buildTopLevelSlackConversationKey(
        last.message,
        ctx.accountId
      );
      if (flushedKey && topLevelConversationKey) {
        const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
        if (pendingKeys) {
          pendingKeys.delete(flushedKey);
          if (pendingKeys.size === 0) {
            pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
          }
        }
      }
      const combinedText = entries.length === 1 ? last.message.text ?? "" : entries.map((entry) => entry.message.text ?? "").filter(Boolean).join("\n");
      const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
      const syntheticMessage = {
        ...last.message,
        text: combinedText
      };
      const prepared = await prepareSlackMessage({
        ctx,
        account,
        message: syntheticMessage,
        opts: {
          ...last.opts,
          wasMentioned: combinedMentioned || last.opts.wasMentioned
        }
      });
      const seenMessageKey = buildSeenMessageKey(last.message.channel, last.message.ts);
      if (!prepared) {
        return;
      }
      if (seenMessageKey) {
        pruneAppMentionRetryKeys(Date.now());
        if (last.opts.source === "app_mention") {
          appMentionDispatchedKeys.set(seenMessageKey, Date.now() + APP_MENTION_RETRY_TTL_MS);
        } else if (last.opts.source === "message" && appMentionDispatchedKeys.has(seenMessageKey)) {
          appMentionDispatchedKeys.delete(seenMessageKey);
          appMentionRetryKeys.delete(seenMessageKey);
          return;
        }
        appMentionRetryKeys.delete(seenMessageKey);
      }
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.message.ts).filter(Boolean);
        if (ids.length > 0) {
          prepared.ctxPayload.MessageSids = ids;
          prepared.ctxPayload.MessageSidFirst = ids[0];
          prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
        }
      }
      await dispatchPreparedSlackMessage(prepared);
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${String(err)}`);
    }
  });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const pendingTopLevelDebounceKeys = /* @__PURE__ */ new Map();
  const appMentionRetryKeys = /* @__PURE__ */ new Map();
  const appMentionDispatchedKeys = /* @__PURE__ */ new Map();
  const pruneAppMentionRetryKeys = (now) => {
    for (const [key, expiresAt] of appMentionRetryKeys) {
      if (expiresAt <= now) {
        appMentionRetryKeys.delete(key);
      }
    }
    for (const [key, expiresAt] of appMentionDispatchedKeys) {
      if (expiresAt <= now) {
        appMentionDispatchedKeys.delete(key);
      }
    }
  };
  const rememberAppMentionRetryKey = (key) => {
    const now = Date.now();
    pruneAppMentionRetryKeys(now);
    appMentionRetryKeys.set(key, now + APP_MENTION_RETRY_TTL_MS);
  };
  const consumeAppMentionRetryKey = (key) => {
    const now = Date.now();
    pruneAppMentionRetryKeys(now);
    if (!appMentionRetryKeys.has(key)) {
      return false;
    }
    appMentionRetryKeys.delete(key);
    return true;
  };
  return async (message, opts) => {
    if (opts.source === "message" && message.type !== "message") {
      return;
    }
    if (opts.source === "message" && message.subtype && message.subtype !== "file_share" && message.subtype !== "bot_message") {
      return;
    }
    const seenMessageKey = buildSeenMessageKey(message.channel, message.ts);
    const wasSeen = seenMessageKey ? ctx.markMessageSeen(message.channel, message.ts) : false;
    if (seenMessageKey && opts.source === "message" && !wasSeen) {
      rememberAppMentionRetryKey(seenMessageKey);
    }
    if (seenMessageKey && wasSeen) {
      if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) {
        return;
      }
    }
    trackEvent?.();
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId);
    const conversationKey = buildTopLevelSlackConversationKey(resolvedMessage, ctx.accountId);
    const canDebounce = debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        const keysToFlush = Array.from(pendingKeys);
        for (const pendingKey of keysToFlush) {
          await debouncer.flushKey(pendingKey);
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? /* @__PURE__ */ new Set();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
    }
    await debouncer.enqueue({ message: resolvedMessage, opts });
  };
}
export {
  buildSlackDebounceKey,
  createSlackMessageHandler
};
