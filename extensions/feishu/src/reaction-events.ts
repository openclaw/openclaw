import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { tryRecordMessagePersistent } from "./dedup.js";
import { isFeishuGroupAllowed, resolveFeishuGroupConfig } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, type FeishuMessageInfo } from "./send.js";
import type { FeishuConfig } from "./types.js";

/**
 * Feishu reaction event payload shape.
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/events/created
 */
export type FeishuReactionEvent = {
  message_id: string;
  reaction_type: {
    emoji_type: string;
  };
  operator_type: string;
  user_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  action_time?: string;
};

// In-memory cache for message info lookups (avoids repeated API calls for the same message).
const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const messageInfoCache = new Map<string, { info: FeishuMessageInfo | null; expireAt: number }>();

async function getCachedMessageInfo(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  const cacheKey = `${params.accountId ?? "default"}:${params.messageId}`;
  const now = Date.now();
  const cached = messageInfoCache.get(cacheKey);
  if (cached && cached.expireAt > now) {
    return cached.info;
  }

  const info = await getMessageFeishu(params);
  messageInfoCache.set(cacheKey, { info, expireAt: now + MESSAGE_CACHE_TTL_MS });
  return info;
}

export async function handleFeishuReactionEvent(params: {
  cfg: ClawdbotConfig;
  event: FeishuReactionEvent;
  action: "added" | "removed";
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, action, botOpenId, runtime, accountId } = params;

  const account = resolveFeishuAccount({ cfg, accountId });
  const feishuCfg = account.config;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const userOpenId = event.user_id.open_id ?? "";
  const emoji = event.reaction_type.emoji_type;
  const messageId = event.message_id;

  // 1. Filter bot's own reactions (typing indicator, etc.)
  if (event.operator_type === "app" || (botOpenId && userOpenId === botOpenId)) {
    return;
  }

  // 2. Dedup — use a namespaced key so reaction events don't collide with message dedup.
  const dedupKey = `reaction:${action}:${messageId}:${userOpenId}:${emoji}`;
  if (!(await tryRecordMessagePersistent(dedupKey, account.accountId, log))) {
    return;
  }

  // 3. Fetch message context to obtain chatId (reaction events don't include it).
  let msgInfo: FeishuMessageInfo | null;
  try {
    msgInfo = await getCachedMessageInfo({ cfg, messageId, accountId: account.accountId });
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to fetch message for reaction: ${String(err)}`);
    return;
  }
  if (!msgInfo) {
    log(`feishu[${account.accountId}]: cannot resolve message ${messageId} for reaction, skipping`);
    return;
  }

  const chatId = msgInfo.chatId;
  if (!chatId) {
    log(`feishu[${account.accountId}]: message ${messageId} has no chatId, skipping reaction`);
    return;
  }

  // 4. Group policy check — only for group chats, DMs skip (same as bot.ts message handling).
  const isGroup = msgInfo.chatType === "group";
  if (isGroup) {
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.feishu !== undefined,
      groupPolicy: feishuCfg?.groupPolicy,
      defaultGroupPolicy,
    });
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied,
      providerKey: "feishu",
      accountId: account.accountId,
      log,
    });

    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    const groupAllowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId: chatId,
      senderName: undefined,
    });
    if (!groupAllowed) {
      log(`feishu[${account.accountId}]: reaction in disallowed group ${chatId}, skipping`);
      return;
    }

    // Additional sender-level allowlist check if group has specific config.
    const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId });
    const senderAllowFrom = groupConfig?.allowFrom ?? [];
    if (senderAllowFrom.length > 0) {
      const senderAllowed = isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: senderAllowFrom,
        senderId: userOpenId,
        senderName: undefined,
      });
      if (!senderAllowed) {
        log(
          `feishu[${account.accountId}]: reaction sender ${userOpenId} not in group sender allowlist`,
        );
        return;
      }
    }
  }

  // 5. Resolve agent route.
  const core = getFeishuRuntime();
  const peerId = isGroup ? chatId : userOpenId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: peerId },
  });

  // 6. Build event text and dispatch system event.
  const preview = (msgInfo.content ?? "").replace(/\s+/g, " ").slice(0, 80);
  const text = `Feishu[${account.accountId}] reaction ${action}: :${emoji}: by ${userOpenId} on msg ${messageId} ("${preview}")`;

  core.system.enqueueSystemEvent(text, {
    sessionKey: route.sessionKey,
    contextKey: `feishu:reaction:${action}:${messageId}:${userOpenId}:${emoji}`,
  });

  log(
    `feishu[${account.accountId}]: reaction ${action} :${emoji}: by ${userOpenId} on ${messageId}`,
  );
}

/** Exported for testing only. */
export function _resetMessageInfoCacheForTest() {
  messageInfoCache.clear();
}
