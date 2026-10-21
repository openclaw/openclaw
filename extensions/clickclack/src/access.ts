import { isDeepStrictEqual } from "node:util";
import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/access-groups";
import {
  formatNormalizedAllowFromEntries,
  resolveAllowlistMatchByCandidates,
} from "openclaw/plugin-sdk/allow-from";
import type { StableChannelIngressIdentityParams } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  buildMentionRegexes,
  normalizeMentionText,
  resolveBotThreadMentionPolicy,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeAgentId,
  type ResolvedAgentRoute,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import { isClickClackAccountCurrent, resolveClickClackAccountConfig } from "./accounts.js";
import { resolveClickClackDiscussionRoute } from "./discussions/routing.js";
import { resolveClickClackGroupPolicy } from "./group-policy.js";
import { createClickClackClient } from "./http-client.js";
import { getClickClackRuntime } from "./runtime.js";
import { buildClickClackTarget } from "./target.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const CHANNEL_ID = "clickclack" as const;
const CLICKCLACK_MENTION_PATTERN = /(?:^|[^a-z0-9_@-])@([a-z0-9][a-z0-9_-]{1,31})(?![a-z0-9_-])/giu;

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

export type ClickClackInboundAccess = Awaited<ReturnType<typeof resolveClickClackInboundAccess>>;

export async function resolveClickClackInboundAccess(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
}) {
  const runtime = getClickClackRuntime();
  const initialGroupPolicy = resolveClickClackGroupPolicy({
    account: params.account,
    channelId: params.message.channel_id,
  });
  const rootPolicyConfigured = initialGroupPolicy.requireMentionInBotThreads !== undefined;
  const isCurrent = () =>
    isClickClackAccountCurrent({
      // SAFETY: Account identity validation only reads the host-validated current config.
      cfg: runtime.config.current() as CoreConfig,
      account: params.account,
    });
  const isBotOwnedThread = rootPolicyConfigured && (await isClickClackBotOwnedThread(params));
  // SAFETY: These legacy policy readers do not mutate the host-validated, frozen config.
  const routeConfig = rootPolicyConfigured
    ? (runtime.config.current() as CoreConfig)
    : params.config;
  const routeAccountConfig = rootPolicyConfigured
    ? resolveClickClackAccountConfig(routeConfig, params.account.accountId)
    : params.account;
  const routingMessage = params.message;
  const routingAccount = { ...params.account, agentId: routeAccountConfig.agentId };
  const routeRuntime = getClickClackRuntime();
  const isDirect = Boolean(routingMessage.direct_conversation_id);
  const target = buildClickClackTarget(
    isDirect
      ? { chatType: "direct", kind: "dm", id: routingMessage.author_id }
      : { chatType: "group", kind: "channel", id: routingMessage.channel_id ?? "" },
  );
  const routingConfig = routeConfig as OpenClawConfig;
  const accountRuntime = getClickClackRuntime();
  const peer: RoutePeer = {
    kind: isDirect ? "direct" : "channel",
    id: target,
  };
  let accountRoute: ResolvedAgentRoute = accountRuntime.channel.routing.resolveAgentRoute({
    cfg: routingConfig,
    channel: CHANNEL_ID,
    accountId: routingAccount.accountId,
    peer,
  });
  const agentId = normalizeAgentId(routingAccount.agentId ?? accountRoute.agentId);
  if (agentId !== accountRoute.agentId) {
    const dmScope = routingConfig.session?.dmScope ?? "main";
    // Account-level agent ownership changes only the agent prefix. Preserve the
    // resolved session policy so outbound recipient routing reaches this key.
    const sessionKey = accountRuntime.channel.routing.buildAgentSessionKey({
      agentId,
      mainKey: routingConfig.session?.mainKey,
      channel: CHANNEL_ID,
      accountId: routingAccount.accountId,
      peer,
      dmScope,
      identityLinks: routingConfig.session?.identityLinks,
    });
    const mainSessionKey = accountRuntime.channel.routing.buildAgentSessionKey({
      agentId,
      mainKey: routingConfig.session?.mainKey,
      channel: CHANNEL_ID,
      accountId: routingAccount.accountId,
      dmScope: "main",
    });
    accountRoute = {
      ...accountRoute,
      agentId,
      dmScope,
      sessionKey,
      mainSessionKey,
      lastRoutePolicy: sessionKey === mainSessionKey ? "main" : "session",
    };
  }
  const discussionResolution = await (!isDirect && routingMessage.channel_id
    ? resolveClickClackDiscussionRoute({
        runtime: routeRuntime,
        accountId: routingAccount.accountId,
        serverBaseUrl: routingAccount.baseUrl,
        workspaceId: routingMessage.workspace_id,
        channelId: routingMessage.channel_id,
      })
    : { state: "unbound" as const });
  const discussionRoute =
    discussionResolution.state === "active" ? discussionResolution.route : undefined;
  const preparedRoute = {
    isDirect,
    target,
    route: discussionRoute
      ? {
          ...accountRoute,
          agentId: discussionRoute.agentId,
          sessionKey: discussionRoute.sessionKey,
          lastRoutePolicy: "session" as const,
        }
      : accountRoute,
    discussionRoute,
    revoked: discussionResolution.state === "revoked",
  };
  const resolveMentionFacts = (mentionConfig: OpenClawConfig, mentionPatterns: string[]) => {
    if (preparedRoute.isDirect) {
      return { canDetectMention: false, wasMentioned: false };
    }
    const body = params.message.body;
    if (!body) {
      return { canDetectMention: true, wasMentioned: false, hasAnyMention: false };
    }
    const sharedMentionRegexes = buildMentionRegexes(mentionConfig, preparedRoute.route.agentId, {
      provider: CHANNEL_ID,
      conversationId: params.message.channel_id,
    });
    const localMentionRegexes = mentionPatterns.length
      ? buildMentionRegexes(
          {
            ...mentionConfig,
            messages: {
              ...mentionConfig.messages,
              groupChat: { ...mentionConfig.messages?.groupChat, mentionPatterns },
            },
          },
          undefined,
          { provider: CHANNEL_ID, conversationId: params.message.channel_id },
        )
      : [];
    const bodyForRegex = normalizeMentionText(body);
    const hasConfiguredMention = [...sharedMentionRegexes, ...localMentionRegexes].some((regex) =>
      regex.test(bodyForRegex),
    );
    const mentionHandles = [...body.matchAll(CLICKCLACK_MENTION_PATTERN)]
      .map((match) => match[1]?.toLowerCase())
      .filter((handle): handle is string => Boolean(handle));
    const botHandle = params.account.botHandle?.replace(/^@/u, "").trim().toLowerCase();
    const hasHandleMention = botHandle ? mentionHandles.includes(botHandle) : false;
    return {
      canDetectMention: true,
      wasMentioned: hasHandleMention || hasConfiguredMention,
      hasAnyMention: mentionHandles.length > 0 || hasConfiguredMention,
    };
  };
  // Root lookup can outlive policy changes. Refresh through the config owner without
  // replacing the running transport's identity or rereading its credentials.
  // SAFETY: The host validates ClickClack settings; the downstream readers remain read-only.
  const cfg = rootPolicyConfigured ? (runtime.config.current() as CoreConfig) : params.config;
  const accountPolicy = rootPolicyConfigured
    ? resolveClickClackAccountConfig(cfg, params.account.accountId)
    : params.account;
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

  const mentionFacts = resolveMentionFacts(cfg, effectiveGroupPolicy.mentionPatterns);
  if (!isCurrent() || (params.message.kind !== undefined && params.message.kind !== "message")) {
    return {
      shouldDispatch: false,
      isCurrent,
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
      isCurrent,
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
          conversationId:
            params.message.parent_message_id && params.message.thread_root_id
              ? params.message.thread_root_id
              : preparedRoute.isDirect
                ? (params.message.direct_conversation_id ?? params.message.author_id)
                : (params.message.channel_id ??
                  params.message.thread_root_id ??
                  params.message.author_id),
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

  const isAdmissionCurrent = () => {
    if (!isCurrent()) {
      return false;
    }
    // Config publishes before the old channel monitor is aborted during reload.
    // Recheck sender and activation policy after ingress awaits and again at dispatch.
    // SAFETY: The policy resolvers only read the host-validated current config.
    const currentCfg = runtime.config.current() as CoreConfig;
    const currentAccountPolicy = resolveClickClackAccountConfig(
      currentCfg,
      params.account.accountId,
    );
    const currentGroupPolicy = resolveClickClackGroupPolicy({
      account: currentAccountPolicy,
      channelId: params.message.channel_id,
    });
    const currentAllowFrom = currentAccountPolicy.allowFrom ?? ["*"];
    const currentIngressAllowFrom = isBotAuthor
      ? currentAllowFrom.filter((entry) => normalizeClickClackUserId(entry) !== "*")
      : currentAllowFrom;
    const directSenderAllowed = resolveAllowlistMatchByCandidates({
      allowList: formatNormalizedAllowFromEntries({
        allowFrom: currentIngressAllowFrom.filter(
          (entry) => parseAccessGroupAllowFromEntry(entry) === null,
        ),
        normalizeEntry: normalizeClickClackUserId,
      }),
      candidates: [
        { value: normalizeClickClackUserId(params.message.author_id) ?? undefined, source: "id" },
      ],
    }).allowed;
    // Reuse only static membership already proved by ingress. A changed definition
    // or removed reference invalidates it; dynamic membership needs its live owner.
    const staticGroupAllowed = currentIngressAllowFrom.some((entry) => {
      const name = parseAccessGroupAllowFromEntry(entry);
      if (!name) {
        return false;
      }
      const group = currentCfg.accessGroups?.[name];
      return (
        group?.type === "message.senders" &&
        resolved.state.allowlists[
          preparedRoute.isDirect ? "dm" : "group"
        ].accessGroups.matched.includes(name) &&
        isDeepStrictEqual(group, cfg.accessGroups?.[name])
      );
    });
    if (!directSenderAllowed && !staticGroupAllowed) {
      return false;
    }
    const currentMentionFacts = resolveMentionFacts(currentCfg, currentGroupPolicy.mentionPatterns);
    if (
      isBotAuthor &&
      currentGroupPolicy.allowBots !== true &&
      !(
        currentGroupPolicy.allowBots === "mentions" &&
        (preparedRoute.isDirect || currentMentionFacts.wasMentioned)
      )
    ) {
      return false;
    }
    const currentThreadPolicy = resolveBotThreadMentionPolicy({
      isBotOwnedThread,
      requireMentionInBotThreads: currentGroupPolicy.requireMentionInBotThreads,
      requireMention: currentGroupPolicy.requireMention,
    });
    return !resolveInboundMentionDecision({
      facts: currentMentionFacts,
      policy: {
        isGroup: !preparedRoute.isDirect,
        requireMention: currentThreadPolicy.requireMention,
        allowTextCommands:
          allowTextCommands &&
          currentAccountPolicy.replyMode !== "model" &&
          runtime.channel.commands.shouldHandleTextCommands({
            cfg: currentCfg,
            surface: CHANNEL_ID,
            commandSource: "text",
          }),
        hasControlCommand:
          shouldCheckCommand &&
          runtime.channel.commands.shouldComputeCommandAuthorized(params.message.body, currentCfg),
        commandAuthorized: resolved.commandAccess.authorized,
      },
    }).shouldSkip;
  };

  return {
    shouldDispatch:
      isAdmissionCurrent() && !preparedRoute.revoked && resolved.ingress.admission === "dispatch",
    isCurrent: isAdmissionCurrent,
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
