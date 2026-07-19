// Discord plugin module implements native model-picker authorization behavior.
import { authorizeNativeCoreCommand } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import { resolveDiscordCommandOwnerAllowFrom, resolveDiscordOwnerAccess } from "./allow-list.js";
import { resolveDiscordNativeAutocompleteAuthorized } from "./native-command-auth.js";
import type { DiscordConfig } from "./native-command.types.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";

type DiscordModelPickerInteraction = ButtonInteraction | StringSelectMenuInteraction;

export type DiscordModelPickerSessionBinding = Readonly<{
  sessionId: string;
  updatedAt: number;
}> | null;

export type DiscordModelPickerAuthorizationResult =
  | { allowed: true }
  | { allowed: false; noticeMessage: string };

export async function authorizeDiscordModelPickerInteraction(params: {
  interaction: DiscordModelPickerInteraction;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  route: ResolvedAgentRoute;
  commandName: "model" | "models";
  rawArguments?: string;
  values?: Record<string, string>;
  /** Explicit null binds authorization to a currently absent session entry. */
  sessionBinding?: DiscordModelPickerSessionBinding;
}): Promise<DiscordModelPickerAuthorizationResult> {
  const user = params.interaction.user;
  if (!user) {
    return { allowed: false, noticeMessage: "You are not authorized to use this command." };
  }
  const isAuthorizedSender = await resolveDiscordNativeAutocompleteAuthorized({
    interaction: params.interaction as unknown as AutocompleteInteraction,
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: params.accountId,
  });
  if (!isAuthorizedSender) {
    return { allowed: false, noticeMessage: "You are not authorized to use this command." };
  }

  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const commandOwnerAllowFrom = resolveDiscordCommandOwnerAllowFrom(params.cfg);
  const { ownerAllowed } = resolveDiscordOwnerAccess({
    allowFrom: commandOwnerAllowFrom,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
    allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig),
  });
  const memberRoleIds = Array.isArray(params.interaction.rawData.member?.roles)
    ? params.interaction.rawData.member.roles.map(String)
    : [];
  const authenticatedChannelId = params.interaction.rawData.channel_id?.trim() ?? "";
  const { isThreadChannel, rawChannelId, threadParentId } =
    await resolveDiscordNativeInteractionChannelContext({
      channel: params.interaction.channel,
      client: params.interaction.client,
      hasGuild: Boolean(params.interaction.guild),
      channelIdFallback: authenticatedChannelId,
    });
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const sessionEntry =
    params.sessionBinding !== undefined
      ? params.sessionBinding
      : getSessionEntry({
          storePath,
          sessionKey: params.route.sessionKey,
          readConsistency: "latest",
        });
  const denial = await authorizeNativeCoreCommand({
    commandName: params.commandName,
    config: params.cfg,
    provider: "discord",
    accountId: params.accountId,
    senderId: sender.id,
    senderName: user.globalName ?? user.username,
    senderUsername: user.username,
    senderIsOwner: ownerAllowed || commandOwnerAllowFrom?.includes("*") === true,
    isAuthorizedSender,
    roleIds: memberRoleIds,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
    sessionId: sessionEntry?.sessionId,
    conversationId: rawChannelId || undefined,
    parentConversationId: isThreadChannel ? threadParentId : undefined,
    threadId: isThreadChannel && rawChannelId ? rawChannelId : undefined,
    rawArguments: params.rawArguments,
    values: params.values,
  });
  return denial
    ? { allowed: false, noticeMessage: "Command blocked by authorization policy." }
    : { allowed: true };
}
