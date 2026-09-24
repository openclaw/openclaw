import type { ChannelBotLoopProtectionFacts } from "openclaw/plugin-sdk/channel-inbound";
/**
 * Maps ClickClack senders and conversations onto the shared channel ingress
 * allowlist/command authorization contract.
 */
import type {
  resolveStableChannelMessageIngress,
  StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeAgentId,
  type ResolvedAgentRoute,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import { listClickClackAccountIds, resolveClickClackAccountConfig } from "./accounts.js";
import { resolveClickClackDiscussionRoute } from "./discussions/routing.js";
import { resolveClickClackGroupPolicy } from "./group-policy.js";
import { createClickClackClient } from "./http-client.js";
import { resolveClickClackMentionFacts } from "./mention-facts.js";
import { getClickClackRuntime } from "./runtime.js";
import { buildClickClackTarget } from "./target.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const CHANNEL_ID = "clickclack" as const;

function normalizeClickClackUserId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutProvider = trimmed.replace(/^(clickclack|cc):/i, "").trim();
  const directTarget = withoutProvider.match(/^dm:(.+)$/i);
  return directTarget?.[1]?.trim() || withoutProvider || null;
}

const clickClackIngressIdentity = {
  key: "user-id",
  normalizeEntry: normalizeClickClackUserId,
  normalizeSubject: normalizeClickClackUserId,
  isWildcardEntry: (entry) => normalizeClickClackUserId(entry) === "*",
  entryIdPrefix: "clickclack-user",
} satisfies StableChannelIngressIdentityParams;

type ClickClackDiscussionRoute = Extract<
  Awaited<ReturnType<typeof resolveClickClackDiscussionRoute>>,
  { state: "active" }
>["route"];

type ClickClackPreparedInboundRoute = {
  isDirect: boolean;
  target: string;
  route: ResolvedAgentRoute;
  discussionRoute?: ClickClackDiscussionRoute;
  revoked: boolean;
};

async function isClickClackBotOwnedThread(params: {
  account: ResolvedClickClackAccount;
  message: ClickClackMessage;
}): Promise<boolean> {
  const { account, message } = params;
  if (
    !account.botUserId ||
    !message.parent_message_id ||
    !message.thread_root_id ||
    message.thread_root_id === message.id ||
    !message.channel_id ||
    message.direct_conversation_id ||
    message.workspace_id !== account.workspace
  ) {
    return false;
  }
  try {
    const root = await createClickClackClient({
      baseUrl: account.apiEndpoint,
      token: account.token,
    }).message(message.thread_root_id);
    return (
      root.id === message.thread_root_id &&
      root.thread_root_id === root.id &&
      !root.parent_message_id &&
      !root.direct_conversation_id &&
      root.workspace_id === message.workspace_id &&
      root.channel_id === message.channel_id &&
      root.author_id === account.botUserId
    );
  } catch {
    // Unreadable roots cannot establish ownership; keep the normal mention policy.
    return false;
  }
}

function resolveClickClackBotLoopConversationId(params: {
  message: ClickClackMessage;
  isDirect: boolean;
}): string {
  if (params.message.parent_message_id && params.message.thread_root_id) {
    return params.message.thread_root_id;
  }
  return params.isDirect
    ? (params.message.direct_conversation_id ?? params.message.author_id)
    : (params.message.channel_id ?? params.message.thread_root_id ?? params.message.author_id);
}

function resolveAccountAgentRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedClickClackAccount;
  target: string;
  isDirect: boolean;
}): ResolvedAgentRoute {
  const runtime = getClickClackRuntime();
  const peer: RoutePeer = {
    kind: params.isDirect ? "direct" : "channel",
    id: params.target,
  };
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer,
  });
  const agentId = normalizeAgentId(params.account.agentId ?? route.agentId);
  if (agentId === route.agentId) {
    return route;
  }
  const dmScope = params.cfg.session?.dmScope ?? "main";
  // Account-level agent ownership changes only the agent prefix. Preserve the
  // resolved session policy so outbound recipient routing reaches this key.
  const sessionKey = runtime.channel.routing.buildAgentSessionKey({
    agentId,
    mainKey: params.cfg.session?.mainKey,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer,
    dmScope,
    identityLinks: params.cfg.session?.identityLinks,
  });
  const mainSessionKey = runtime.channel.routing.buildAgentSessionKey({
    agentId,
    mainKey: params.cfg.session?.mainKey,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    dmScope: "main",
  });
  return {
    ...route,
    agentId,
    dmScope,
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: sessionKey === mainSessionKey ? "main" : "session",
  };
}

async function resolvePreparedInboundRoute(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
}): Promise<ClickClackPreparedInboundRoute> {
  const runtime = getClickClackRuntime();
  const isDirect = Boolean(params.message.direct_conversation_id);
  const target = buildClickClackTarget(
    isDirect
      ? { chatType: "direct", kind: "dm", id: params.message.author_id }
      : { chatType: "group", kind: "channel", id: params.message.channel_id ?? "" },
  );
  const accountRoute = resolveAccountAgentRoute({
    cfg: params.config as OpenClawConfig,
    account: params.account,
    target,
    isDirect,
  });
  const discussionResolution =
    !isDirect && params.message.channel_id
      ? await resolveClickClackDiscussionRoute({
          runtime,
          accountId: params.account.accountId,
          serverBaseUrl: params.account.baseUrl,
          workspaceId: params.message.workspace_id,
          channelId: params.message.channel_id,
        })
      : { state: "unbound" as const };
  const discussionRoute =
    discussionResolution.state === "active" ? discussionResolution.route : undefined;

  return {
    isDirect,
    target,
    route: discussionRoute
      ? {
          ...accountRoute,
          agentId: discussionRoute.agentId,
          sessionKey: discussionRoute.sessionKey,
          lastRoutePolicy: "session",
        }
      : accountRoute,
    discussionRoute,
    revoked: discussionResolution.state === "revoked",
  };
}

/**
 * Dispatch and command authorization decision for one inbound ClickClack
 * message.
 */
export type ClickClackInboundAccess = {
  shouldDispatch: boolean;
  commandAuthorized: boolean;
  /** Whether the resolved group policy required a direct mention. */
  requireMention?: boolean;
  mentionFacts: {
    canDetectMention: boolean;
    wasMentioned: boolean;
    hasAnyMention?: boolean;
  };
  botLoopProtection?: ChannelBotLoopProtectionFacts;
  preparedRoute: ClickClackPreparedInboundRoute;
  channelIngress?: Awaited<ReturnType<typeof resolveStableChannelMessageIngress>>;
};

/**
 * Resolves whether a ClickClack message should enter the agent pipeline and
 * whether its command-style body may run tools.
 */
export async function resolveClickClackInboundAccess(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
}): Promise<ClickClackInboundAccess> {
  const runtime = getClickClackRuntime();
  const initialGroupPolicy = resolveClickClackGroupPolicy({
    account: params.account,
    channelId: params.message.channel_id,
  });
  const rootPolicyConfigured = initialGroupPolicy.requireMentionInBotThreads !== undefined;
  const isBotOwnedThread = rootPolicyConfigured && (await isClickClackBotOwnedThread(params));
  // SAFETY: These legacy policy readers do not mutate the host-validated, frozen config.
  const routeConfig = rootPolicyConfigured
    ? (runtime.config.current() as CoreConfig)
    : params.config;
  const routeAccountConfig = rootPolicyConfigured
    ? resolveClickClackAccountConfig(routeConfig, params.account.accountId)
    : params.account;
  const preparedRoute = await resolvePreparedInboundRoute({
    ...params,
    config: routeConfig,
    account: { ...params.account, agentId: routeAccountConfig.agentId },
  });
  // Root lookup can outlive policy changes. Refresh through the config owner without
  // replacing the running transport's identity or rereading its credentials.
  // SAFETY: The host validates ClickClack settings; the downstream readers remain read-only.
  const cfg = rootPolicyConfigured ? (runtime.config.current() as CoreConfig) : params.config;
  const accountPolicy = rootPolicyConfigured
    ? resolveClickClackAccountConfig(cfg, params.account.accountId)
    : params.account;
  const accountAvailable =
    !rootPolicyConfigured ||
    (Boolean(cfg.channels?.clickclack) &&
      listClickClackAccountIds(cfg).includes(params.account.accountId) &&
      cfg.channels?.clickclack?.enabled !== false &&
      accountPolicy.enabled !== false &&
      Boolean(accountPolicy.baseUrl?.trim() && accountPolicy.workspace?.trim()));
  const effectiveGroupPolicy = resolveClickClackGroupPolicy({
    account: accountPolicy,
    channelId: params.message.channel_id,
  });
  const threadMentionPolicy = resolveBotThreadMentionPolicy({
    isBotOwnedThread,
    requireMentionInBotThreads: effectiveGroupPolicy.requireMentionInBotThreads,
    requireMention: effectiveGroupPolicy.requireMention,
  });
  const shouldCheckCommand = runtime.channel.commands.shouldComputeCommandAuthorized(
    params.message.body,
    cfg,
  );

  const mentionFacts = resolveClickClackMentionFacts({
    isDirect: preparedRoute.isDirect,
    body: params.message.body,
    mentionPatterns: effectiveGroupPolicy.mentionPatterns,
    botHandle: params.account.botHandle,
    cfg,
    agentId: preparedRoute.route.agentId,
    channelId: params.message.channel_id,
  });
  if (
    !accountAvailable ||
    (params.message.kind !== undefined && params.message.kind !== "message")
  ) {
    return {
      shouldDispatch: false,
      commandAuthorized: false,
      requireMention: threadMentionPolicy.requireMention,
      mentionFacts,
      preparedRoute,
    };
  }
  // Older ClickClack servers may omit author classification. Preserve the
  // legacy ingress path for those responses and apply bot-only policy only to
  // messages positively classified as bot-authored.
  const isBotAuthor = params.message.author?.kind === "bot";
  // The account's default allowFrom is wildcarded for human traffic. Bot
  // admission is a separate opt-in boundary, so wildcard authorization must
  // not implicitly trust every bot in the workspace.
  const allowFrom = accountPolicy.allowFrom ?? ["*"];
  const ingressAllowFrom = isBotAuthor
    ? allowFrom.filter((entry) => normalizeClickClackUserId(entry) !== "*")
    : allowFrom;
  const botMentionAllowed =
    !isBotAuthor ||
    effectiveGroupPolicy.allowBots === true ||
    (effectiveGroupPolicy.allowBots === "mentions" &&
      (preparedRoute.isDirect || mentionFacts.wasMentioned));
  if (!botMentionAllowed) {
    return {
      shouldDispatch: false,
      commandAuthorized: false,
      requireMention: threadMentionPolicy.requireMention,
      mentionFacts,
      preparedRoute,
    };
  }
  const botLoopNowMs = parseDateStringTimestampMs(params.message.created_at);
  const botLoopProtection =
    isBotAuthor && params.message.author_id !== params.account.botUserId && params.account.botUserId
      ? {
          // Keep reciprocal ClickClack accounts in one loop-guard namespace.
          // The workspace is the shared boundary; account IDs would let the
          // same conversation evade the budget by alternating receivers.
          scopeId: params.account.workspace,
          conversationId: resolveClickClackBotLoopConversationId({
            message: params.message,
            isDirect: preparedRoute.isDirect,
          }),
          senderId: params.message.author_id,
          receiverId: params.account.botUserId,
          eventId: params.message.id,
          ...(botLoopNowMs !== undefined ? { nowMs: botLoopNowMs } : {}),
          config: effectiveGroupPolicy.botLoopProtection,
          defaultsConfig: cfg.channels?.defaults?.botLoopProtection,
          defaultEnabled: true,
        }
      : undefined;
  const allowTextCommands =
    accountPolicy.replyMode !== "model" &&
    runtime.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: CHANNEL_ID,
      commandSource: "text",
    });

  const resolved = await runtime.channel.inbound.ingress.resolveStable({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    identity: clickClackIngressIdentity,
    cfg,
    subject: { stableId: params.message.author_id },
    conversation: {
      kind: preparedRoute.isDirect ? "direct" : "group",
      id: preparedRoute.isDirect
        ? (params.message.direct_conversation_id ?? params.message.author_id)
        : (params.message.channel_id ?? params.message.thread_root_id),
    },
    contextBinding: {
      agentId: preparedRoute.route.agentId,
      sessionKey: preparedRoute.route.sessionKey,
      nativeChannelId: params.message.channel_id || params.message.direct_conversation_id,
      messageId: params.message.id,
      inboundEventKind: "user_request",
    },
    allowFrom: ingressAllowFrom,
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    mentionFacts,
    policy: {
      activation: {
        requireMention: threadMentionPolicy.requireMention,
        allowTextCommands,
      },
    },
    command: shouldCheckCommand
      ? {
          cfg,
          modeWhenAccessGroupsOff: "configured",
        }
      : false,
  });

  return {
    shouldDispatch: !preparedRoute.revoked && resolved.ingress.admission === "dispatch",
    commandAuthorized: resolved.commandAccess.requested
      ? resolved.commandAccess.authorized
      : resolved.senderAccess.allowed,
    requireMention: threadMentionPolicy.requireMention,
    mentionFacts,
    botLoopProtection,
    preparedRoute,
    channelIngress: resolved,
  };
}
