import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  resolveRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { parseSlackTarget, type SlackTargetKind } from "../../targets.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";

export type SlackRoutingContextDeps = {
  cfg: OpenClawConfig;
  teamId: string;
  threadInheritParent: boolean;
  threadHistoryScope: "thread" | "channel";
};

type SlackRoutingContext = {
  route: ReturnType<typeof resolveAgentRoute>;
  runtimeBinding: RuntimeConversationBindingRouteResult["bindingRecord"];
  runtimeBoundSessionKey: string | undefined;
  chatType: "direct" | "group" | "channel";
  replyToMode: ReturnType<typeof resolveSlackReplyToMode>;
  threadContext: ReturnType<typeof resolveSlackThreadContext>;
  threadTs: string | undefined;
  isThreadReply: boolean;
  messageThreadId: string | undefined;
  allowDirectMessagePlanStream: boolean;
  threadKeys: ReturnType<typeof resolveThreadSessionKeys>;
  sessionKey: string;
  historyKey: string;
};

type SlackRouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type SlackRouteBindingPeer = NonNullable<SlackRouteBinding["match"]["peer"]>;

const slackRouteBindingConfigCache = new WeakMap<
  OpenClawConfig,
  { bindingsRef: OpenClawConfig["bindings"]; normalizedCfg: OpenClawConfig }
>();

function slackTargetDefaultKindForPeer(kind: SlackRouteBindingPeer["kind"]): SlackTargetKind {
  return kind === "direct" ? "user" : "channel";
}

function slackTargetKindMatchesPeer(
  peerKind: SlackRouteBindingPeer["kind"],
  targetKind: SlackTargetKind,
): boolean {
  if (targetKind === "user") {
    return peerKind === "direct";
  }
  return peerKind === "channel" || peerKind === "group";
}

function normalizeSlackRouteBindingPeer(peer: SlackRouteBindingPeer): SlackRouteBindingPeer {
  const rawId = peer.id.trim();
  if (!rawId || rawId === "*") {
    return peer;
  }

  const target = (() => {
    try {
      return parseSlackTarget(rawId, {
        defaultKind: slackTargetDefaultKindForPeer(peer.kind),
      });
    } catch {
      return undefined;
    }
  })();
  if (!target || !slackTargetKindMatchesPeer(peer.kind, target.kind) || target.id === peer.id) {
    return peer;
  }
  return { ...peer, id: target.id };
}

function normalizeSlackRouteBindingConfig(cfg: OpenClawConfig): OpenClawConfig {
  const bindings = cfg.bindings;
  const cached = slackRouteBindingConfigCache.get(cfg);
  if (cached && cached.bindingsRef === bindings) {
    return cached.normalizedCfg;
  }
  if (!Array.isArray(bindings)) {
    return cfg;
  }

  let changed = false;
  const normalizedBindings = bindings.map((binding) => {
    if (binding.type === "acp" || binding.match.channel.trim().toLowerCase() !== "slack") {
      return binding;
    }
    const peer = binding.match.peer;
    if (!peer) {
      return binding;
    }
    const normalizedPeer = normalizeSlackRouteBindingPeer(peer);
    if (normalizedPeer === peer) {
      return binding;
    }
    changed = true;
    return {
      ...binding,
      match: {
        ...binding.match,
        peer: normalizedPeer,
      },
    };
  });

  const normalizedCfg = changed
    ? ({ ...cfg, bindings: normalizedBindings } as OpenClawConfig)
    : cfg;
  slackRouteBindingConfigCache.set(cfg, { bindingsRef: bindings, normalizedCfg });
  return normalizedCfg;
}

function resolveSlackBaseConversationId(params: {
  message: SlackMessageEvent;
  isDirectMessage: boolean;
}): string {
  return params.isDirectMessage
    ? `user:${params.message.user ?? "unknown"}`
    : params.message.channel;
}

function normalizeStoredThreadId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function resolveCanonicalDirectMessageThreadId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainSessionKey: string;
  accountId: string;
  senderId?: string;
}): string | undefined {
  if (!params.senderId) {
    return undefined;
  }
  const store = loadSessionStore(
    resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    }),
  );
  const resolved = resolveSessionStoreEntry({
    store,
    sessionKey: params.mainSessionKey,
  });
  const entry = resolved.existing;
  if (!entry) {
    return undefined;
  }
  const storedChannel =
    typeof entry.deliveryContext?.channel === "string"
      ? entry.deliveryContext.channel
      : (entry.lastChannel ??
        (typeof entry.origin?.provider === "string" ? entry.origin.provider : undefined));
  const storedTo =
    typeof entry.deliveryContext?.to === "string"
      ? entry.deliveryContext.to
      : (entry.lastTo ?? (typeof entry.origin?.to === "string" ? entry.origin.to : undefined));
  const storedAccountId =
    typeof entry.deliveryContext?.accountId === "string"
      ? entry.deliveryContext.accountId
      : (entry.lastAccountId ??
        (typeof entry.origin?.accountId === "string" ? entry.origin.accountId : undefined));
  const storedThreadId = normalizeStoredThreadId(
    entry.deliveryContext?.threadId ?? entry.lastThreadId ?? entry.origin?.threadId,
  );
  if (storedChannel !== "slack") {
    return undefined;
  }
  if (storedTo !== `user:${params.senderId}`) {
    return undefined;
  }
  if (storedAccountId && storedAccountId !== params.accountId) {
    return undefined;
  }
  return storedThreadId;
}

export function resolveSlackRoutingContext(params: {
  ctx: SlackRoutingContextDeps;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
  seedTopLevelRoomThread?: boolean;
}): SlackRoutingContext {
  const {
    ctx,
    account,
    message,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    seedTopLevelRoomThread,
  } = params;
  let route = resolveSlackInitialAgentRoute({
    ctx,
    account,
    message,
    isDirectMessage,
    isRoom,
  });

  const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
  const replyToMode = resolveSlackReplyToMode(account, chatType);
  const threadContext = resolveSlackThreadContext({ message, replyToMode });
  const threadTs = threadContext.incomingThreadTs;
  const isThreadReply = threadContext.isThreadReply;
  const canonicalDmThreadId =
    isDirectMessage && !isThreadReply && replyToMode === "all"
      ? resolveCanonicalDirectMessageThreadId({
          cfg: ctx.cfg,
          agentId: route.agentId,
          mainSessionKey: route.mainSessionKey,
          accountId: account.accountId,
          senderId: message.user,
        })
      : undefined;
  // Keep true thread replies thread-scoped, but preserve channel-level sessions
  // for top-level room turns when replyToMode is off.
  // For DMs, preserve existing auto-thread behavior when replyToMode="all".
  const autoThreadId =
    !isThreadReply && replyToMode === "all"
      ? (canonicalDmThreadId ?? threadContext.messageTs)
      : undefined;
  // Keep ordinary top-level room messages on the per-channel session for
  // continuity, but preserve Slack thread identity when the event already has
  // one or when an actionable app mention will seed a reply thread.
  // This keeps a thread root and its later replies on one parent session
  // without returning to the old "every channel message is its own thread"
  // behavior (regression from #10686).
  const seedCandidateThreadId = threadContext.incomingThreadTs ?? threadContext.messageTs;
  const seededRoomThreadId =
    !isThreadReply &&
    isRoom &&
    seedTopLevelRoomThread &&
    replyToMode !== "off" &&
    seedCandidateThreadId
      ? seedCandidateThreadId
      : undefined;
  const roomThreadId = isThreadReply && threadTs ? threadTs : undefined;
  const canonicalThreadId = isRoomish ? roomThreadId : isThreadReply ? threadTs : autoThreadId;
  const messageThreadId = canonicalThreadId ?? threadContext.messageThreadId;
  const baseConversationId = resolveSlackBaseConversationId({ message, isDirectMessage });
  const boundThreadRoute = routedThreadId
    ? resolveRuntimeConversationBindingRoute({
        route,
        conversation: {
          channel: "slack",
          accountId: account.accountId,
          conversationId: routedThreadId,
          parentConversationId: baseConversationId,
        },
      })
    : null;
  const runtimeRoute =
    boundThreadRoute?.boundSessionKey || boundThreadRoute?.bindingRecord
      ? boundThreadRoute
      : resolveRuntimeConversationBindingRoute({
          route,
          conversation: {
            channel: "slack",
            accountId: account.accountId,
            conversationId: baseConversationId,
          },
        });
  route = runtimeRoute.route;
  const threadKeys = runtimeRoute.boundSessionKey
    ? { sessionKey: route.sessionKey, parentSessionKey: undefined }
    : resolveThreadSessionKeys({
        baseSessionKey: route.sessionKey,
        threadId: routedThreadId,
        parentSessionKey: routedThreadId && ctx.threadInheritParent ? route.sessionKey : undefined,
      });
  const sessionKey = threadKeys.sessionKey;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;

  return {
    route,
    runtimeBinding: runtimeRoute.bindingRecord,
    runtimeBoundSessionKey: runtimeRoute.boundSessionKey,
    chatType,
    replyToMode,
    threadContext,
    threadTs,
    isThreadReply,
    messageThreadId,
    allowDirectMessagePlanStream: Boolean(
      isDirectMessage && !isThreadReply && replyToMode === "all" && canonicalThreadId,
    ),
    threadKeys,
    sessionKey,
    historyKey,
  };
}
