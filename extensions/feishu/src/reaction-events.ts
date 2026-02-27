import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  createScopedPairingAccess,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { tryRecordMessagePersistent } from "./dedup.js";
import {
  isFeishuGroupAllowed,
  resolveFeishuAllowlistMatch,
  resolveFeishuGroupConfig,
} from "./policy.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, type FeishuMessageInfo } from "./send.js";
import type { FeishuConfig } from "./types.js";

/**
 * Feishu reaction event payload shape.
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/events/created
 */
export type FeishuReactionEvent = {
  message_id?: string;
  reaction_type?: {
    emoji_type: string;
  };
  operator_type?: string;
  user_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  action_time?: string;
};

// In-memory cache for message info lookups (avoids repeated API calls for the same message).
const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const MESSAGE_CACHE_EVICT_INTERVAL_MS = 60 * 1000;
const messageInfoCache = new Map<string, { info: FeishuMessageInfo; expireAt: number }>();
let lastEvictMs = 0;

function evictExpiredCacheEntries(now: number): void {
  if (now - lastEvictMs < MESSAGE_CACHE_EVICT_INTERVAL_MS) return;
  lastEvictMs = now;
  for (const [key, entry] of messageInfoCache) {
    if (entry.expireAt <= now) messageInfoCache.delete(key);
  }
}

async function getCachedMessageInfo(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  const cacheKey = `${params.accountId ?? "default"}:${params.messageId}`;
  const now = Date.now();
  evictExpiredCacheEntries(now);
  const cached = messageInfoCache.get(cacheKey);
  if (cached && cached.expireAt > now) {
    return cached.info;
  }

  const info = await getMessageFeishu(params);
  if (info) {
    messageInfoCache.set(cacheKey, { info, expireAt: now + MESSAGE_CACHE_TTL_MS });
  }
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

  const userOpenId = event.user_id?.open_id ?? "";
  const emoji = event.reaction_type?.emoji_type ?? "";
  const messageId = event.message_id ?? "";

  if (!messageId || !emoji) {
    log(`feishu[${account.accountId}]: reaction event missing message_id or emoji, skipping`);
    return;
  }

  // 1. Filter bot's own reactions (typing indicator, etc.)
  if (event.operator_type === "app" || (botOpenId && userOpenId && userOpenId === botOpenId)) {
    return;
  }

  // 2. Dedup — include action_time so add→remove→add cycles are not collapsed.
  const actionTime = event.action_time ?? "";
  const dedupKey = `reaction:${action}:${messageId}:${userOpenId}:${emoji}:${actionTime}`;
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

  // 4. Policy checks.
  const core = getFeishuRuntime();
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
      const senderAllowed = resolveFeishuAllowlistMatch({
        allowFrom: senderAllowFrom,
        senderId: userOpenId,
        senderIds: [event.user_id?.user_id],
      }).allowed;
      if (!senderAllowed) {
        log(
          `feishu[${account.accountId}]: reaction sender ${userOpenId} not in group sender allowlist`,
        );
        return;
      }
    }
  } else {
    // DM policy check — block unauthorized senders (mirrors bot.ts DM handling).
    const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
    if (dmPolicy !== "open") {
      const configAllowFrom = feishuCfg?.allowFrom ?? [];
      const pairing = createScopedPairingAccess({
        core,
        channel: "feishu",
        accountId: account.accountId,
      });
      const storeAllowFrom =
        dmPolicy !== "allowlist" ? await pairing.readAllowFromStore().catch(() => []) : [];
      const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
      const dmAllowed = resolveFeishuAllowlistMatch({
        allowFrom: effectiveDmAllowFrom,
        senderId: userOpenId,
        senderIds: [event.user_id?.user_id],
      }).allowed;
      if (!dmAllowed) {
        log(
          `feishu[${account.accountId}]: reaction from unauthorized DM sender ${userOpenId}, skipping`,
        );
        return;
      }
    }
  }

  // 5. Resolve agent route (with topic session support).
  let peerId = isGroup ? chatId : userOpenId;
  let parentPeer: { kind: "group"; id: string } | null = null;
  if (isGroup && msgInfo.rootId) {
    const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId });
    const topicSessionMode =
      groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? "disabled";
    if (topicSessionMode === "enabled") {
      parentPeer = { kind: "group", id: chatId };
      peerId = `${chatId}:topic:${msgInfo.rootId}`;
    }
  }
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: peerId },
    parentPeer,
  });

  // 6. Enqueue system event and dispatch to agent so it can decide whether to reply.
  const preview = (msgInfo.content ?? "").replace(/\s+/g, " ").slice(0, 80);
  const eventText = `Feishu[${account.accountId}] reaction ${action}: :${emoji}: by ${userOpenId} on msg ${messageId} ("${preview}")`;

  core.system.enqueueSystemEvent(eventText, {
    sessionKey: route.sessionKey,
    contextKey: `feishu:reaction:${action}:${messageId}:${userOpenId}:${emoji}`,
  });

  // Build a lightweight inbound body for the agent.
  const body = `[System: reaction ${action} :${emoji}: by ${userOpenId} on message ${messageId} ("${preview}")]`;
  const feishuTo = isGroup ? `chat:${chatId}` : `user:${userOpenId}`;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: `feishu:${userOpenId}`,
    To: feishuTo,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    GroupSubject: isGroup ? chatId : undefined,
    SenderName: userOpenId,
    SenderId: userOpenId,
    Provider: "feishu" as const,
    Surface: "feishu" as const,
    MessageSid: `reaction:${messageId}:${actionTime}`,
    Timestamp: Date.now(),
    WasMentioned: false,
    CommandAuthorized: false,
    OriginatingChannel: "feishu" as const,
    OriginatingTo: feishuTo,
  });

  const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
    cfg,
    agentId: route.agentId,
    runtime: runtime as RuntimeEnv,
    chatId,
    replyToMessageId: messageId,
    accountId: account.accountId,
  });

  log(
    `feishu[${account.accountId}]: reaction ${action} :${emoji}: by ${userOpenId} on ${messageId}, dispatching to agent`,
  );

  await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => {
      markDispatchIdle();
    },
    run: () =>
      core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      }),
  });
}

/** Exported for testing only. */
export function _resetMessageInfoCacheForTest() {
  messageInfoCache.clear();
  lastEvictMs = 0;
}
