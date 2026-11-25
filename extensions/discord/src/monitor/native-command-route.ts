import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveConfiguredBindingRoute } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BaseComponentInteraction, CommandInteraction } from "../internal/discord.js";
import type { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type ConfiguredBindingResolution = NonNullable<
  NonNullable<ReturnType<typeof resolveConfiguredBindingRoute>>["bindingResolution"]
>;

type DiscordNativeInteractionRouteState = {
  effectiveRoute: ResolvedAgentRoute;
  boundSessionKey?: string;
  configuredBinding: ConfiguredBindingResolution | null;
};

export function resolveDiscordNativeInteractionRouteState(params: {
  cfg: OpenClawConfig;
  accountId: string;
  interaction: CommandInteraction | BaseComponentInteraction;
  channelContext: Awaited<ReturnType<typeof resolveDiscordNativeInteractionChannelContext>>;
  threadBindings?: ThreadBindingManager;
  conversationId?: string;
}): DiscordNativeInteractionRouteState {
  const { channelContext, interaction } = params;
  const conversationId = params.conversationId ?? channelContext.rawChannelId;
  const threadBinding = channelContext.isThreadChannel
    ? params.threadBindings?.getByThreadId(channelContext.rawChannelId)
    : undefined;
  const route = resolveDiscordConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId: interaction.guild?.id,
    memberRoleIds: channelContext.memberRoleIds,
    peer: buildDiscordRoutePeer({
      isDirectMessage: channelContext.isDirectMessage,
      isGroupDm: channelContext.isGroupDm,
      directUserId: interaction.user?.id ?? channelContext.rawChannelId,
      conversationId,
    }),
    parentConversationId: channelContext.threadParentId,
  });
  const configuredRoute =
    threadBinding == null
      ? resolveConfiguredBindingRoute({
          cfg: params.cfg,
          route,
          conversation: {
            channel: "discord",
            accountId: params.accountId,
            conversationId,
            parentConversationId: channelContext.threadParentId,
          },
        })
      : null;
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  const configuredBoundSessionKey = normalizeOptionalString(configuredRoute?.boundSessionKey);
  const boundSessionKey =
    normalizeOptionalString(threadBinding?.targetSessionKey) ?? configuredBoundSessionKey;
  const effectiveRoute = resolveDiscordEffectiveRoute({
    route,
    boundSessionKey,
    configuredRoute,
    matchedBy: configuredBinding ? "binding.channel" : undefined,
  });
  return { effectiveRoute, boundSessionKey, configuredBinding };
}
