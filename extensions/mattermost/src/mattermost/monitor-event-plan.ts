import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveMattermostReplyToMode } from "./accounts.js";
import type { MattermostChannel } from "./client.js";
import { resolveMattermostTrustedChatKind } from "./monitor-auth.js";
import { resolveMattermostThreadSessionContext } from "./monitor-context.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { logTypingFailure } from "./runtime-api.js";

type MattermostEventPlanParams = {
  channelId: string;
  senderId: string;
  postId?: string | null;
  /**
   * Set when the event comes from a bot-authored interactive post (model picker,
   * question card, button row). Such a post is a UI container inside the conversation
   * it was opened from, so it must never seed a new thread session of its own: the
   * thread root (if any) still applies, but `postId` is not used as a thread anchor.
   */
  interactionPost?: boolean;
  threadRootId?: string | null;
  channelInfo?: MattermostChannel | null;
  channelTypeFallback?: string | null;
  teamId?: string | null;
  channelName?: string | null;
  channelDisplay?: string | null;
  dropLabel: string;
};

export async function buildMattermostEventPlan(
  monitor: MattermostMonitorContext,
  params: MattermostEventPlanParams,
) {
  // Gather transport metadata once, normalize its optional labels, then decide
  // the route/thread identity every event consumer must share.
  const channelInfo =
    params.channelInfo ?? (await monitor.resources.resolveChannelInfo(params.channelId));
  const channelType = channelInfo?.type?.trim() || params.channelTypeFallback?.trim();
  if (!channelType) {
    monitor.logVerboseMessage(
      `mattermost: drop ${params.dropLabel} (cannot resolve channel type for ${params.channelId})`,
    );
    return null;
  }
  const kind = resolveMattermostTrustedChatKind({ channelType });
  const teamId = params.teamId ?? channelInfo?.team_id ?? undefined;
  const channelName = params.channelName ?? channelInfo?.name ?? "";
  const channelDisplay = params.channelDisplay ?? channelInfo?.display_name ?? channelName;
  const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${params.channelId}`;
  const route = monitor.core.channel.routing.resolveAgentRoute({
    cfg: monitor.cfg,
    channel: "mattermost",
    accountId: monitor.account.accountId,
    teamId,
    peer: {
      kind,
      id: kind === "direct" ? params.senderId : params.channelId,
    },
  });
  const thread = resolveMattermostThreadSessionContext({
    baseSessionKey: route.sessionKey,
    kind,
    // A user's top-level post may open a thread session (replyToMode first/all/batched).
    // An interactive post is never a conversation root: a picker or question card posted
    // at the DM/channel root belongs to the root session, not to a thread keyed by itself.
    postId: params.interactionPost ? undefined : params.postId,
    replyToMode: resolveMattermostReplyToMode(monitor.account, kind),
    threadRootId: params.threadRootId,
  });
  const to = kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;
  const from =
    kind === "direct"
      ? `mattermost:${params.senderId}`
      : kind === "group"
        ? `mattermost:group:${params.channelId}`
        : `mattermost:channel:${params.channelId}`;

  return {
    channelId: params.channelId,
    senderId: params.senderId,
    kind,
    channelDisplay,
    channelName,
    teamId,
    roomLabel,
    route,
    thread,
    to,
    from,
    finalizeContext: <T extends Record<string, unknown>>(context: T) =>
      finalizeInboundContext({
        ...context,
        From: from,
        To: to,
        SessionKey: thread.sessionKey,
        DmScope: route.dmScope,
        ParentSessionKey: thread.parentSessionKey,
        AccountId: route.accountId,
        ChatType: kind,
        ConversationRouteContextObserved: true,
        ConversationRoutePeerId: kind === "direct" ? params.senderId : params.channelId,
        GroupChannel: channelName ? `#${channelName}` : undefined,
        GroupSpace: teamId,
        SenderId: params.senderId,
        Provider: "mattermost" as const,
        Surface: "mattermost" as const,
        ReplyToId: thread.effectiveReplyToId,
        MessageThreadId: thread.effectiveReplyToId,
        NativeChannelId: params.channelId,
        InboundAccessAuthorized: true,
        OriginatingChannel: "mattermost" as const,
        OriginatingTo: to,
      }),
    createReplyPlan: () => ({
      textLimit: monitor.core.channel.text.resolveTextChunkLimit(
        monitor.cfg,
        "mattermost",
        monitor.account.accountId,
        { fallbackLimit: monitor.account.textChunkLimit ?? 4000 },
      ),
      tableMode: monitor.core.channel.text.resolveMarkdownTableMode({
        cfg: monitor.cfg,
        channel: "mattermost",
        accountId: monitor.account.accountId,
      }),
      replyPipeline: {
        typing: {
          start: () =>
            monitor.resources.sendTypingIndicator(params.channelId, thread.effectiveReplyToId),
          onStartError: (error: unknown) => {
            logTypingFailure({
              log: monitor.logDebugMessage,
              channel: "mattermost",
              target: params.channelId,
              error,
            });
          },
        },
      },
      replyOptions: {
        disableBlockStreaming:
          monitor.account.blockStreaming === undefined
            ? undefined
            : !monitor.account.blockStreaming,
      },
    }),
  };
}

export type MattermostEventPlan = NonNullable<Awaited<ReturnType<typeof buildMattermostEventPlan>>>;
