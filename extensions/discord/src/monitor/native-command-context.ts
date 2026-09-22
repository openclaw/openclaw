import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  resolveNativeCommandSessionTargets,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import { getDiscordRuntime } from "../runtime.js";
import type { DiscordChannelConfigResolved, DiscordGuildEntryResolved } from "./allow-list.js";
import { resolveDiscordChannelTopicSafe } from "./channel-access.js";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";
import { discordIngressIdentity } from "./ingress-identity.js";
import type { DiscordBuildInboundContext } from "./native-command.types.js";
import type { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { buildDiscordRoutePeer } from "./route-resolution.js";

type BuildDiscordNativeCommandContextParams = {
  prompt: string;
  commandArgs: CommandArgs;
  sessionKey: string;
  commandTargetSessionKey: string;
  accountId: string;
  agentId: string;
  buildContext?: DiscordBuildInboundContext;
  interactionId: string;
  channelId: string;
  threadParentId?: string;
  memberRoleIds?: string[];
  guildId?: string;
  guildName?: string;
  channelTopic?: string;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  commandAuthorized: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isGuild: boolean;
  isThreadChannel: boolean;
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
  timestampMs?: number;
};

export async function buildDiscordNativeCommandContext(
  params: BuildDiscordNativeCommandContextParams,
) {
  const conversationLabel = params.isDirectMessage
    ? (params.user.globalName ?? params.user.username)
    : params.channelId;
  const { groupSystemPrompt, ownerAllowFrom, channelStructuredContext } =
    buildDiscordInboundAccessContext({
      channelConfig: params.channelConfig,
      guildInfo: params.guildInfo,
      sender: params.sender,
      allowNameMatching: params.allowNameMatching,
      isGuild: params.isGuild,
      channelTopic: params.channelTopic,
    });

  const conversation = {
    kind: params.isDirectMessage
      ? ("direct" as const)
      : params.isGroupDm
        ? ("group" as const)
        : ("channel" as const),
    id: params.channelId,
    parentId: params.isThreadChannel ? params.threadParentId : undefined,
    threadId: params.isThreadChannel ? params.channelId : undefined,
  };
  // Native admission has already checked the live channel, member, DM, and command policy.
  // Carry that decision through the same identity-bound host ingress as ordinary messages.
  const allowFrom = params.commandAuthorized ? [`user:${params.user.id}`] : [];
  const channelIngress = await getDiscordRuntime()
    .channel.inbound.ingress.createResolver({
      channelId: "discord",
      accountId: params.accountId,
      identity: discordIngressIdentity,
      useDefaultPairingStore: false,
    })
    .command({
      subject: {
        stableId: params.user.id,
        aliases: { participantKind: "user" },
      },
      conversation,
      contextBinding: {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        nativeChannelId: params.channelId,
        messageId: params.interactionId,
        inboundEventKind: "user_request",
      },
      event: { kind: "native-command", mayPair: false },
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom,
      groupAllowFrom: allowFrom,
      command: { modeWhenAccessGroupsOff: "configured" },
    });
  return await (params.buildContext ?? buildChannelInboundEventContext)({
    channel: "discord",
    channelIngress,
    accountId: params.accountId,
    messageId: params.interactionId,
    timestamp: params.timestampMs ?? Date.now(),
    from: params.isDirectMessage
      ? `discord:${params.user.id}`
      : params.isGroupDm
        ? `discord:group:${params.channelId}`
        : `discord:channel:${params.channelId}`,
    sender: {
      id: params.user.id,
      name: params.user.globalName ?? params.user.username,
      username: params.user.username,
      tag: params.sender.tag,
      roles: params.memberRoleIds,
    },
    conversation: {
      ...conversation,
      nativeChannelId: params.channelId,
      routePeer: buildDiscordRoutePeer({
        isDirectMessage: params.isDirectMessage,
        isGroupDm: params.isGroupDm,
        directUserId: params.user.id,
        conversationId: params.channelId,
      }),
      label: conversationLabel,
      spaceId: params.isGuild
        ? (params.guildInfo?.id ?? params.guildInfo?.slug ?? params.guildId)
        : undefined,
    },
    route: {
      agentId: params.agentId,
      accountId: params.accountId,
      routeSessionKey: params.commandTargetSessionKey,
      dispatchSessionKey: params.sessionKey,
    },
    reply: {
      to: `slash:${params.user.id}`,
      // Interactions reply through slash:<user>; follow-ups use the real Discord target.
      originatingTo:
        resolveDiscordConversationIdentity({
          isDirectMessage: params.isDirectMessage,
          userId: params.user.id,
          channelId: params.channelId,
        }) ?? (params.isDirectMessage ? `user:${params.user.id}` : `channel:${params.channelId}`),
    },
    message: { rawBody: params.prompt },
    access: {
      mentions: { canDetectMention: true, wasMentioned: true },
      commands: { authorized: params.commandAuthorized },
    },
    commandTurn: {
      kind: "native",
      source: "native",
      authorized: params.commandAuthorized,
      body: params.prompt,
    },
    supplemental: { groupSystemPrompt },
    extra: {
      CommandArgs: params.commandArgs,
      CommandTargetSessionKey: params.commandTargetSessionKey,
      CommandSource: "native",
      GroupSubject: params.isGuild ? params.guildName : undefined,
      ChannelStructuredContext: channelStructuredContext,
      OwnerAllowFrom: ownerAllowFrom,
    },
  });
}

export async function buildDiscordNativeInteractionContext(
  params: Pick<
    BuildDiscordNativeCommandContextParams,
    | "prompt"
    | "commandArgs"
    | "user"
    | "sender"
    | "channelConfig"
    | "guildInfo"
    | "allowNameMatching"
    | "commandAuthorized"
    | "buildContext"
  > & {
    interaction:
      | CommandInteraction
      | ButtonInteraction
      | StringSelectMenuInteraction
      | AutocompleteInteraction;
    route: ResolvedAgentRoute;
    boundSessionKey?: string;
    sessionPrefix: string;
    channelContext: Awaited<ReturnType<typeof resolveDiscordNativeInteractionChannelContext>>;
  },
) {
  const { interaction, route, boundSessionKey, sessionPrefix, channelContext, ...context } = params;
  const targets = resolveNativeCommandSessionTargets({
    agentId: route.agentId,
    sessionPrefix,
    userId: context.user.id,
    targetSessionKey: route.sessionKey,
    boundSessionKey,
  });
  const ctxPayload = await buildDiscordNativeCommandContext({
    ...context,
    ...targets,
    agentId: route.agentId,
    accountId: route.accountId,
    interactionId: interaction.rawData.id,
    channelId: channelContext.rawChannelId || "unknown",
    threadParentId: channelContext.threadParentId,
    memberRoleIds: Array.isArray(interaction.rawData.member?.roles)
      ? interaction.rawData.member.roles
      : [],
    guildId: interaction.guild?.id,
    guildName: interaction.guild?.name,
    channelTopic: resolveDiscordChannelTopicSafe(interaction.channel),
    isGuild: Boolean(interaction.guild),
    isDirectMessage: channelContext.isDirectMessage,
    isGroupDm: channelContext.isGroupDm,
    isThreadChannel: channelContext.isThreadChannel,
  });
  return { ctxPayload, ...targets };
}
