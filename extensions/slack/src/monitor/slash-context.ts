import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { resolveConversationLabel } from "openclaw/plugin-sdk/conversation-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveSlackCommandIngress } from "./auth.js";
import type { SlackChannelConfigResolved } from "./channel-config.js";
import type {
  normalizeSlackChannelType,
  resolveSlackChatType,
  SlackMonitorContext,
} from "./context.js";
import { resolveSlackDeferredActionTarget } from "./deferred-action-routing.js";
import type { resolveSlackRoomContextHints } from "./room-context.js";
import type { SlackCommandInvocation } from "./types.js";

export async function buildSlackSlashCommandContext(params: {
  ctx: SlackMonitorContext;
  invocation: SlackCommandInvocation;
  route: ResolvedAgentRoute;
  routingTeamId?: string;
  channelType: ReturnType<typeof normalizeSlackChannelType>;
  channelInfo: Awaited<ReturnType<SlackMonitorContext["resolveChannelName"]>>;
  channelConfig: SlackChannelConfigResolved | null;
  isRoom: boolean;
  isRoomish: boolean;
  isDirectMessage: boolean;
  chatType: ReturnType<typeof resolveSlackChatType>;
  senderName: string;
  finalAllowFromLower: string[];
  sessionKey: string;
  routePeerId: string;
  slashUserTarget: ReturnType<typeof resolveSlackDeferredActionTarget>;
  slashReplyTarget: string;
  commandTargetSessionKey: string;
  roomContext: ReturnType<typeof resolveSlackRoomContextHints>;
  resolveConversationLabel: typeof resolveConversationLabel;
}) {
  const {
    ctx,
    invocation: p,
    route,
    routingTeamId,
    channelType,
    channelInfo,
    channelConfig,
    isRoom,
    isRoomish,
    isDirectMessage,
    chatType,
    senderName,
    finalAllowFromLower,
    sessionKey,
    routePeerId,
    slashUserTarget,
    slashReplyTarget,
    commandTargetSessionKey,
    resolveConversationLabel,
  } = params;
  const { command, eventScope, prompt, commandArgs } = p;
  const { channelMetadata, groupSystemPrompt } = params.roomContext;
  const channelName = channelInfo?.name;
  const roomLabel = channelName ? `#${channelName}` : `#${command.channel_id}`;
  const from = isDirectMessage
    ? `slack:${routePeerId}`
    : isRoom
      ? `slack:channel:${routePeerId}`
      : `slack:group:${routePeerId}`;
  const messageId = p.eventTs ?? command.trigger_id;
  const finalIngress = await resolveSlackCommandIngress({
    ctx,
    teamId: routingTeamId,
    senderId: command.user_id,
    senderAuthentication: p.senderAuthentication,
    senderName,
    channelType: channelType ?? "channel",
    channelId: command.channel_id,
    threadId: p.threadTs,
    ownerAllowFromLower: finalAllowFromLower,
    channelUsers: isRoom ? channelConfig?.users : undefined,
    allowTextCommands: false,
    hasControlCommand: false,
    eventKind: "slash-command",
    modeWhenAccessGroupsOff: "configured",
    contextBinding: {
      agentId: route.agentId,
      sessionKey,
      messageId,
      nativeChannelId: command.channel_id,
      inboundEventKind: "user_request",
    },
  });
  if (
    finalIngress.ingress.admission !== "dispatch" ||
    (isRoomish && finalIngress.senderAccess.gate?.allowed === false) ||
    (isRoomish && ctx.useAccessGroups && !finalIngress.commandAccess.authorized) ||
    !ctx.isRuntimePolicyCurrent() ||
    !ctx.isChannelAllowed({
      teamId: routingTeamId,
      channelId: command.channel_id,
      channelName: channelInfo?.name,
      channelType,
    })
  ) {
    return undefined;
  }
  const commandAuthorized = finalIngress.commandAccess.authorized;
  const originatingTo = p.threadTs
    ? resolveSlackDeferredActionTarget({
        eventScope,
        kind: "channel",
        id: command.channel_id,
      }).target
    : slashReplyTarget;
  const ctxPayload = (ctx.buildContext ?? buildChannelInboundEventContext)({
    channelIngress: finalIngress,
    channel: "slack",
    accountId: route.accountId,
    messageId,
    timestamp: Date.now(),
    from,
    sender: { id: command.user_id, name: senderName },
    conversation: {
      kind: chatType,
      id: command.channel_id,
      threadId: p.threadTs,
      nativeChannelId: command.channel_id,
      spaceId: routingTeamId,
      label:
        resolveConversationLabel({
          ChatType: chatType,
          SenderName: senderName,
          GroupSubject: isRoomish ? roomLabel : undefined,
          From: from,
        }) ?? (isDirectMessage ? senderName : roomLabel),
    },
    route: { ...route, routeSessionKey: route.sessionKey, dispatchSessionKey: sessionKey },
    reply: {
      to: `slash:${slashUserTarget.peerId}`,
      originatingTo,
      messageThreadId: p.threadTs,
      nativeChannelId: command.channel_id,
    },
    message: {
      inboundEventKind: "user_request",
      body: prompt,
      bodyForAgent: prompt,
      rawBody: prompt,
      commandBody: prompt,
    },
    access: {
      mentions: { canDetectMention: true, wasMentioned: true },
      commands: { authorized: commandAuthorized },
    },
    command: {
      kind: "native",
      authorized: commandAuthorized,
      body: prompt,
    },
    supplemental: { groupSystemPrompt },
    extra: {
      CommandArgs: commandArgs,
      CommandTargetSessionKey: commandTargetSessionKey,
      ChannelPromptContext: channelMetadata ? [channelMetadata] : undefined,
    },
  });
  return { ctxPayload, commandAuthorized };
}
