import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { captureSessionEntryCurrentCheck } from "openclaw/plugin-sdk/session-binding-runtime";
import {
  getConversationSessionAsync,
  resolveStorePath,
  type SessionEntrySourceAuthority,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import {
  normalizeSlackRouteBindingConfig,
  resolveSlackConversationBindingRouteAsync,
} from "../../conversation-binding-route.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import { readSlackAssistantThreadContext } from "../assistant-thread-context.js";
import type { SlackChannelConfigResolved } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { getSlackSessionRuns } from "../session-run-targets.js";
import {
  qualifySlackConversationId,
  qualifySlackRoutePeerId,
  resolveSlackAgentRoute,
} from "../workspace-routing.js";

type SlackRoutingContextDeps = Pick<
  SlackMonitorContext,
  "cfg" | "teamId" | "threadInheritParent" | "threadHistoryScope"
>;

type SlackRoutingContext = Awaited<ReturnType<typeof resolveSlackRoutingContext>>;

export async function resolveSlackRoutingContext(params: {
  ctx: SlackRoutingContextDeps;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  chatType: "direct" | "group" | "channel";
  channelConfig?: SlackChannelConfigResolved | null;
  seedTopLevelRoomThread?: boolean;
  assistantThreadTs?: string;
  agentViewThreadTs?: string;
  eventScope?: SlackEventScope;
}) {
  const {
    ctx,
    account,
    message,
    chatType,
    channelConfig,
    seedTopLevelRoomThread,
    assistantThreadTs,
    agentViewThreadTs,
    eventScope,
  } = params;
  const isDirectMessage = chatType === "direct";
  const isRoom = chatType === "channel";
  const replyToMode = channelConfig?.replyToMode ?? resolveSlackReplyToMode(account, chatType);
  const threadContext = resolveSlackThreadContext({ message, replyToMode, isDirectMessage });
  const threadTs = threadContext.incomingThreadTs;
  const isThreadReply = threadContext.isThreadReply;
  // Keep ordinary top-level room messages on the per-channel session for
  // continuity, but preserve Slack thread identity when the event already has
  // one or when an actionable app mention will seed a reply thread.
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
  const directAgentThreadId = assistantThreadTs ?? agentViewThreadTs;
  // DM threads are a UI affordance, not a session boundary. Route all DM
  // messages, including thread replies, to the user's main DM session so
  // the agent sees them as part of the existing conversation. Slack Assistant
  // View and Agent View threads are the exception: each visible root is its
  // own conversation.
  const routedThreadId = isDirectMessage
    ? directAgentThreadId
    : (roomThreadId ?? seededRoomThreadId);
  const baseConversationId = qualifySlackConversationId(
    isDirectMessage ? `user:${message.user ?? "unknown"}` : message.channel,
    eventScope,
  );
  const runtimeBindingThreadId =
    routedThreadId ?? (isDirectMessage && isThreadReply ? threadTs : undefined);
  const bindingRoute = await resolveSlackConversationBindingRouteAsync({
    cfg: ctx.cfg,
    resolveRoute: ({ boundAgentId, bindingOwnerAvailable }) =>
      resolveSlackAgentRoute({
        cfg:
          boundAgentId || !bindingOwnerAvailable
            ? { session: ctx.cfg.session }
            : normalizeSlackRouteBindingConfig(ctx.cfg),
        defaultAgentId: boundAgentId,
        accountId: account.accountId,
        teamId: eventScope?.teamId || ctx.teamId || undefined,
        peer: {
          kind: chatType,
          id: isDirectMessage ? (message.user ?? "unknown") : message.channel,
        },
        eventScope,
      }),
    accountId: account.accountId,
    baseConversationId,
    runtimeBindingThreadId,
    bindingsEnabled: !eventScope,
  });
  const runtimeRoute = bindingRoute.runtimeRoute;
  const configuredBinding = bindingRoute.configuredRoute?.bindingResolution ?? null;
  const configuredBindingSessionKey = bindingRoute.configuredRoute?.boundSessionKey ?? "";
  const route = bindingRoute.route;
  const threadKeys =
    runtimeRoute.boundSessionKey || configuredBindingSessionKey
      ? { sessionKey: route.sessionKey, parentSessionKey: undefined }
      : resolveThreadSessionKeys({
          baseSessionKey: route.sessionKey,
          threadId: routedThreadId,
          parentSessionKey:
            routedThreadId && ctx.threadInheritParent ? route.sessionKey : undefined,
        });
  const sessionKey = threadKeys.sessionKey;
  return {
    route,
    runtimeBinding: runtimeRoute.bindingRecord,
    runtimeBoundSessionKey: runtimeRoute.boundSessionKey,
    configuredBinding,
    configuredBindingSessionKey,
    chatType,
    replyToMode,
    threadContext,
    threadTs,
    isThreadReply,
    threadKeys,
    sessionKey,
  };
}

export async function resolveSlackSessionEventRoutingContext(
  params: Omit<
    Parameters<typeof resolveSlackRoutingContext>[0],
    "ctx" | "assistantThreadTs" | "agentViewThreadTs"
  > & { ctx: SlackMonitorContext; intent: "stop" | "title" },
): Promise<
  SlackRoutingContext & {
    isCurrentSession: () => boolean;
    assertCurrentSession: SessionEntrySourceAuthority;
  }
> {
  const { ctx, message, eventScope } = params;
  const threadTs = message.thread_ts;
  const routing = await resolveSlackRoutingContext(params);
  const address = {
    agentId: routing.route.agentId,
    storePath: resolveStorePath(ctx.cfg.session?.store, { agentId: routing.route.agentId }),
    channel: "slack",
    accountId: params.account.accountId,
    kind: routing.chatType,
    peerId: qualifySlackRoutePeerId({
      id: params.chatType === "direct" ? (message.user ?? "unknown") : message.channel,
      kind: params.chatType === "direct" ? "user" : "channel",
      eventScope,
    }),
  };
  const threadAddress = { ...address, threadId: threadTs };
  const liveAddress = { channelId: message.channel, threadTs, eventScope };
  let allowDirectParent = false;
  const readOwner = async (): Promise<
    | {
        route: SlackRoutingContext["route"];
        source: "recorded" | "live" | "parent";
        isActive?: () => boolean;
      }
    | undefined
  > => {
    const recorded = await getConversationSessionAsync(threadAddress);
    if (recorded) {
      return {
        route: { ...routing.route, sessionKey: recorded.sessionKey },
        source: "recorded",
      };
    }
    // First-mode roots publish in a native thread with an unthreaded ingress address.
    const live = getSlackSessionRuns(ctx, liveAddress).at(-1);
    if (live) {
      return { route: live.route, source: "live", isActive: live.isActive };
    }
    const parent = allowDirectParent ? await getConversationSessionAsync(address) : undefined;
    return parent
      ? { route: { ...routing.route, sessionKey: parent.sessionKey }, source: "parent" }
      : undefined;
  };
  let owner = await readOwner();
  if (owner?.source === "live" && params.chatType === "direct") {
    // Keep a proven ordinary DM parent after its publisher finishes, without
    // borrowing a parent for a managed thread that never had that live owner.
    allowDirectParent =
      (await getConversationSessionAsync(address))?.sessionKey === owner.route.sessionKey;
  }
  if (!owner && params.chatType === "direct" && threadTs) {
    const assistantContext = ctx.getSlackAssistantThreadContext(
      message.channel,
      threadTs,
      eventScope,
    );
    const managedThread =
      !eventScope &&
      ((await ctx.isSlackManagedViewThread(message.channel, threadTs)) ||
        (await ctx.isSlackAgentView()));
    const assistantThread =
      assistantContext ??
      (managedThread
        ? undefined
        : await readSlackAssistantThreadContext({
            client: eventScope?.client ?? ctx.app.client,
            channelId: message.channel,
            threadTs,
            userId: message.user,
          }));
    allowDirectParent = !assistantThread && !managedThread;
    owner = await readOwner();
  }
  if (!owner) {
    throw new Error("No recorded session owns this Slack conversation");
  }
  const { route } = owner;
  const readLiveOwner = () => getSlackSessionRuns(ctx, liveAddress).at(-1);
  const current = await captureSessionEntryCurrentCheck({
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    storePath: resolveStorePath(ctx.cfg.session?.store, { agentId: route.agentId }),
    isActive: params.intent === "stop" ? owner.isActive : undefined,
    matchGeneration: params.intent === "stop",
    errorMessage:
      params.intent === "title"
        ? "Slack conversation owner changed before the title update"
        : "The selected session changed before it could be stopped.",
    alternatives: [
      { conversations: [{ ...threadAddress, sessionKey: route.sessionKey }] },
      {
        conversations: [{ ...threadAddress, sessionKey: null }],
        isActive: () => readLiveOwner()?.route.sessionKey === route.sessionKey,
      },
      ...(allowDirectParent
        ? [
            {
              conversations: [
                { ...threadAddress, sessionKey: null },
                { ...address, sessionKey: route.sessionKey },
              ],
              isActive: () => !readLiveOwner(),
            },
          ]
        : []),
    ],
  });
  return {
    ...routing,
    route,
    sessionKey: route.sessionKey,
    isCurrentSession: current.isCurrent,
    assertCurrentSession: current.assertCurrent,
  };
}
