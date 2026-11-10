import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  resolveNativeCommandSessionTargets,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import type { BaseComponentInteraction, CommandInteraction } from "../internal/discord.js";
import { getDiscordRuntime } from "../runtime.js";
import type { DiscordChannelConfigResolved, DiscordGuildEntryResolved } from "./allow-list.js";
import { resolveDiscordChannelTopicSafe } from "./channel-access.js";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";
import { discordIngressIdentity } from "./ingress-identity.js";
import type { DiscordBuildInboundContext } from "./native-command.types.js";
import type { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { buildDiscordRoutePeer } from "./route-resolution.js";

export async function buildDiscordNativeInteractionContext(params: {
  cfg: OpenClawConfig;
  prompt: string;
  commandArgs: CommandArgs;
  buildContext?: DiscordBuildInboundContext;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  commandAuthorized: boolean;
  user: {
    id: string;
    username: string;
    globalName?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  interaction: CommandInteraction | BaseComponentInteraction;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  sessionPrefix: string;
  channelContext: Awaited<ReturnType<typeof resolveDiscordNativeInteractionChannelContext>>;
}) {
  const { interaction, route, boundSessionKey, sessionPrefix, channelContext, ...context } = params;
  const targets = resolveNativeCommandSessionTargets({
    agentId: route.agentId,
    sessionPrefix,
    userId: context.user.id,
    targetSessionKey: route.sessionKey,
    boundSessionKey,
  });
  const agentId = route.agentId;
  const accountId = route.accountId;
  const interactionId = interaction.rawData.id;
  const channelId = channelContext.rawChannelId || "unknown";
  const threadParentId = channelContext.threadParentId;
  const memberRoleIds = channelContext.memberRoleIds;
  const guildId = interaction.guild?.id;
  const guildName = interaction.guild?.name;
  const channelTopic = resolveDiscordChannelTopicSafe(interaction.channel);
  const isGuild = Boolean(interaction.guild);
  const isDirectMessage = channelContext.isDirectMessage;
  const isGroupDm = channelContext.isGroupDm;
  const isThreadChannel = channelContext.isThreadChannel;
  const conversationLabel = isDirectMessage
    ? (context.user.globalName ?? context.user.username)
    : channelId;
  const { groupSystemPrompt, ownerAllowFrom, channelStructuredContext, toolPolicy } =
    buildDiscordInboundAccessContext({
      ...context,
      accountId,
      parentId: threadParentId,
      channelTopic,
      isGuild,
      senderName: context.user.globalName ?? context.user.username,
      senderUsername: context.user.username,
    });

  const conversation = {
    kind: isDirectMessage
      ? ("direct" as const)
      : isGroupDm
        ? ("group" as const)
        : ("channel" as const),
    id: channelId,
    parentId: isThreadChannel ? threadParentId : undefined,
    threadId: isThreadChannel ? channelId : undefined,
  };
  // Native admission has already checked the live channel, member, DM, and command policy.
  // Carry that decision through the same identity-bound host ingress as ordinary messages.
  const allowFrom = context.commandAuthorized ? [`user:${context.user.id}`] : [];
  const channelIngress = await getDiscordRuntime()
    .channel.inbound.ingress.createResolver({
      channelId: "discord",
      accountId,
      identity: discordIngressIdentity,
      useDefaultPairingStore: false,
    })
    .command({
      subject: {
        stableId: context.user.id,
        aliases: { participantKind: "user" },
      },
      conversation,
      contextBinding: {
        agentId,
        sessionKey: targets.sessionKey,
        nativeChannelId: channelId,
        messageId: interactionId,
        inboundEventKind: "user_request",
      },
      event: { kind: "native-command", mayPair: false },
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom,
      groupAllowFrom: allowFrom,
      command: { modeWhenAccessGroupsOff: "configured" },
    });
  const ctxPayload = await (context.buildContext ?? buildChannelInboundEventContext)({
    channel: "discord",
    channelIngress,
    accountId,
    messageId: interactionId,
    timestamp: Date.now(),
    from: isDirectMessage
      ? `discord:${context.user.id}`
      : isGroupDm
        ? `discord:group:${channelId}`
        : `discord:channel:${channelId}`,
    sender: {
      id: context.user.id,
      name: context.user.globalName ?? context.user.username,
      username: context.user.username,
      tag: context.sender.tag,
      roles: memberRoleIds,
    },
    conversation: {
      ...conversation,
      nativeChannelId: channelId,
      routePeer: buildDiscordRoutePeer({
        isDirectMessage,
        isGroupDm,
        directUserId: context.user.id,
        conversationId: channelId,
      }),
      label: conversationLabel,
      spaceId: isGuild ? (context.guildInfo?.id ?? context.guildInfo?.slug ?? guildId) : undefined,
    },
    route: {
      agentId,
      accountId,
      routeSessionKey: targets.commandTargetSessionKey,
      dispatchSessionKey: targets.sessionKey,
    },
    reply: {
      to: `slash:${context.user.id}`,
      // Interactions reply through slash:<user>; follow-ups use the real Discord target.
      originatingTo:
        resolveDiscordConversationIdentity({
          isDirectMessage,
          userId: context.user.id,
          channelId,
        }) ?? (isDirectMessage ? `user:${context.user.id}` : `channel:${channelId}`),
    },
    message: { rawBody: context.prompt },
    access: {
      toolPolicy,
      mentions: { canDetectMention: true, wasMentioned: true },
      commands: { authorized: context.commandAuthorized },
    },
    commandTurn: {
      kind: "native",
      source: "native",
      authorized: context.commandAuthorized,
      body: context.prompt,
    },
    supplemental: { groupSystemPrompt },
    extra: {
      CommandArgs: context.commandArgs,
      CommandTargetSessionKey: targets.commandTargetSessionKey,
      CommandSource: "native",
      GroupSubject: isGuild ? guildName : undefined,
      ChannelStructuredContext: channelStructuredContext,
      OwnerAllowFrom: ownerAllowFrom,
    },
  });
  return { ctxPayload, ...targets };
}
