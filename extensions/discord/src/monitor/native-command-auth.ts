import {
  resolveCommandAuthorization,
  resolveCommandAuthorizedFromAuthorizers,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordAccountAllowFrom, resolveDiscordAccountDmPolicy } from "../accounts.js";
import { resolveDiscordCommandOwnerAllowFrom } from "../command-owners.js";
import type { AutocompleteInteraction, Guild } from "../internal/discord.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordChannelPolicyCommandAuthorizer,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { createDiscordLivePolicyReader, type DiscordLivePolicyReader } from "./live-policy.js";
import { buildDiscordNativeInteractionContext } from "./native-command-context.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import type { DiscordCommandArgContext } from "./native-command-ui.types.js";
import type { DiscordBuildInboundContext, DiscordConfig } from "./native-command.types.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

export function resolveDiscordNativePolicyReader(
  params: Pick<DiscordCommandArgContext, "cfg" | "discordConfig" | "accountId" | "readPolicy">,
): DiscordLivePolicyReader {
  return (
    params.readPolicy ??
    createDiscordLivePolicyReader({
      ...params,
      readConfig: () => getRuntimeConfigSnapshot() ?? params.cfg,
      resolvedAllowlist: {
        guildEntries: params.discordConfig?.guilds,
        allowFrom: params.discordConfig?.allowFrom ?? resolveDiscordAccountAllowFrom(params),
      },
    })
  );
}

export function createDiscordNativeCommandAuthority(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  commandAuthorized: boolean;
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
  isPolicyCurrent?: () => boolean;
  accountId: string;
  guildId?: string;
  commandName: string;
  pluginCommand: boolean;
}) {
  const assertAdmittedOwner = resolveCommandAuthorization(params).assertOwnerCurrent;
  const readAuthorization = () => {
    const cfg = getRuntimeConfigSnapshot() ?? params.cfg;
    const owners = resolveDiscordCommandOwnerAllowFrom(cfg);
    const senderIsOwner =
      params.isPolicyCurrent?.() !== false &&
      (resolveDiscordOwnerAccess({
        allowFrom: owners,
        sender: params.sender,
        allowNameMatching: params.allowNameMatching,
      }).ownerAllowed ||
        resolveCommandAuthorization({ ...params, cfg }).senderIsOwner);
    const commands = resolveDiscordNativeCommandAllowlistAccess({
      cfg,
      sender: params.sender,
      guildId: params.guildId,
    });
    return {
      senderIsOwner,
      allowed:
        (!commands.configured || commands.allowed) &&
        (!owners ||
          owners.includes("*") ||
          senderIsOwner ||
          commands.allowed ||
          params.commandName === "status" ||
          params.pluginCommand),
    };
  };
  const assertActive = () => {
    assertAdmittedOwner?.();
    if (params.isPolicyCurrent?.() === false || !readAuthorization().allowed) {
      throw new Error("Discord command authority changed; send a new request.");
    }
  };
  return {
    assertActive,
    assertOwnerCurrent: () => {
      assertActive();
      if (!readAuthorization().senderIsOwner) {
        throw new Error("Discord owner authority changed; send a new request.");
      }
    },
    senderIsOwner: () => readAuthorization().senderIsOwner,
    isAllowed: () => {
      try {
        assertActive();
        return true;
      } catch {
        return false;
      }
    },
  };
}

function resolveDiscordNativeCommandAllowlistAccess(params: {
  cfg: OpenClawConfig;
  sender: { id: string; name?: string; tag?: string };
  guildId?: string | null;
}) {
  const commandsAllowFrom = params.cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return { configured: false, allowed: false } as const;
  }
  const rawAllowList = Array.isArray(commandsAllowFrom.discord)
    ? commandsAllowFrom.discord
    : commandsAllowFrom["*"];
  if (!Array.isArray(rawAllowList)) {
    return { configured: false, allowed: false } as const;
  }
  const guildId = normalizeOptionalString(params.guildId);
  if (guildId) {
    for (const entry of rawAllowList) {
      const text = normalizeOptionalString(String(entry)) ?? "";
      if (text.startsWith("guild:") && text.slice("guild:".length) === guildId) {
        return { configured: true, allowed: true } as const;
      }
    }
  }
  const allowList = normalizeDiscordAllowList(rawAllowList.map(String), [
    "discord:",
    "user:",
    "pk:",
  ]);
  if (!allowList) {
    return { configured: true, allowed: false } as const;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: params.sender,
    allowNameMatching: false,
  });
  return { configured: true, allowed: match.allowed } as const;
}

export function resolveDiscordNativeCommandChannelAccessContext(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  sender: { id: string; name?: string; tag?: string };
  isThreadChannel: boolean;
  guild?: Guild<true> | Guild | null;
  rawChannelId: string;
  channelName?: string;
  channelSlug: string;
  threadParentId?: string;
  threadParentName?: string;
  threadParentSlug?: string;
}) {
  const guild = params.guild ?? null;
  const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
    cfg: params.cfg,
    sender: params.sender,
    guildId: guild?.id,
  });
  const guildInfo = resolveDiscordGuildEntry({
    guild: guild ?? undefined,
    guildId: guild?.id ?? undefined,
    guildEntries: params.discordConfig?.guilds,
  });
  const channelConfig = guild
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: params.rawChannelId,
        channelName: params.channelName,
        channelSlug: params.channelSlug,
        parentId: params.threadParentId,
        parentName: params.threadParentName,
        parentSlug: params.threadParentSlug,
        scope: params.isThreadChannel ? "thread" : "channel",
      })
    : null;
  return { commandsAllowFromAccess, guildInfo, channelConfig } as const;
}

export async function resolveDiscordGuildNativeCommandAuthorized(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  commandsAllowFromAccess: ReturnType<typeof resolveDiscordNativeCommandAllowlistAccess>;
  guildInfo?: ReturnType<typeof resolveDiscordGuildEntry> | null;
  channelConfig?: ReturnType<typeof resolveDiscordChannelConfigWithFallback> | null;
  memberRoleIds: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
  ownerAllowListConfigured: boolean;
  ownerAllowed: boolean;
}) {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
    groupPolicy,
    guildInfo: params.guildInfo,
    channelConfig: params.channelConfig,
  });
  if (!policyAuthorizer.allowed) {
    return false;
  }
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    memberRoleIds: params.memberRoleIds,
    sender: params.sender,
    allowNameMatching: params.allowNameMatching,
  });
  const ownerAuthorizer = {
    configured: params.ownerAllowListConfigured,
    allowed: params.ownerAllowed,
  };
  const memberAuthorizer = {
    configured: hasAccessRestrictions,
    allowed: memberAllowed,
  };
  const hasStricterAccessRestrictions = ownerAuthorizer.configured || memberAuthorizer.configured;
  const policyFallbackAuthorizer = {
    configured: policyAuthorizer.configured && !hasStricterAccessRestrictions,
    allowed: policyAuthorizer.allowed,
  };
  const fallbackAuthorizers = [policyFallbackAuthorizer, ownerAuthorizer, memberAuthorizer];
  const authorizers = params.commandsAllowFromAccess.configured
    ? [params.commandsAllowFromAccess]
    : fallbackAuthorizers;
  return resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: true,
    authorizers,
    modeWhenAccessGroupsOff: "configured",
  });
}

export function resolveDiscordNativeGroupDmAccess(params: {
  isGroupDm: boolean;
  groupEnabled?: boolean;
  groupChannels?: string[];
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): { allowed: true } | { allowed: false; reason: "disabled" | "not-allowlisted" } {
  if (!params.isGroupDm) {
    return { allowed: true };
  }
  if (params.groupEnabled === false) {
    return { allowed: false, reason: "disabled" };
  }
  if (
    !resolveGroupDmAllow({
      channels: params.groupChannels,
      channelId: params.channelId,
      channelName: params.channelName,
      channelSlug: params.channelSlug,
    })
  ) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}

export async function resolveDiscordNativeAutocompleteAuthorized(params: {
  isPolicyCurrent?: () => boolean;
  interaction: AutocompleteInteraction;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  skipCommandOwnerAllowFrom?: boolean;
  sessionPrefix?: string;
  threadBindings?: ThreadBindingManager;
  buildContext?: DiscordBuildInboundContext;
}): Promise<boolean> {
  const { interaction, cfg, discordConfig, accountId } = params;
  const user = interaction.user;
  if (!user) {
    return false;
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const channelContext = await resolveDiscordNativeInteractionChannelContext({
    channel: interaction.channel,
    client: interaction.client,
    hasGuild: Boolean(interaction.guild),
    channelIdFallback: interaction.rawData.channel_id ?? "",
  });
  const {
    isDirectMessage,
    isGroupDm,
    isThreadChannel,
    channelName,
    channelSlug,
    rawChannelId,
    threadParentId,
  } = channelContext;
  if (params.isPolicyCurrent?.() === false) {
    return false;
  }
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const configuredDmAllowFrom =
    resolveDiscordAccountAllowFrom({
      cfg,
      accountId,
    }) ?? [];
  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: configuredDmAllowFrom,
    sender,
    allowNameMatching,
  });
  const { commandsAllowFromAccess, guildInfo, channelConfig } =
    resolveDiscordNativeCommandChannelAccessContext({
      cfg,
      discordConfig,
      sender,
      ...channelContext,
      guild: interaction.guild ?? null,
    });
  if (channelConfig?.enabled === false) {
    return false;
  }
  if (interaction.guild && channelConfig?.allowed === false) {
    return false;
  }
  if (interaction.guild) {
    const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.discord !== undefined,
      groupPolicy: discordConfig?.groupPolicy,
      defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy,
    });
    const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
      groupPolicy,
      guildInfo,
      channelConfig,
    });
    if (!policyAuthorizer.allowed) {
      return false;
    }
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId }) ?? "pairing";
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      return false;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId,
      dmPolicy,
      configuredAllowFrom: configuredDmAllowFrom,
      sender,
      allowNameMatching,
      cfg,
      rest: interaction.client.rest,
    });
    if (params.isPolicyCurrent?.() === false || dmAccess.senderAccess.decision !== "allow") {
      return false;
    }
  }
  const groupDmAccess = resolveDiscordNativeGroupDmAccess({
    isGroupDm,
    groupEnabled: discordConfig?.dm?.groupEnabled,
    groupChannels: discordConfig?.dm?.groupChannels,
    channelId: rawChannelId,
    channelName,
    channelSlug,
  });
  if (!groupDmAccess.allowed) {
    return false;
  }
  if (!isDirectMessage) {
    const authorized = await resolveDiscordGuildNativeCommandAuthorized({
      cfg,
      discordConfig,
      commandsAllowFromAccess,
      guildInfo,
      channelConfig,
      memberRoleIds,
      sender,
      allowNameMatching,
      ownerAllowListConfigured: ownerAllowList != null,
      ownerAllowed: ownerOk,
    });
    if (!authorized) {
      return false;
    }
  }
  const commandOwnerAllowFrom = resolveDiscordCommandOwnerAllowFrom(cfg);
  if (
    params.skipCommandOwnerAllowFrom !== true &&
    commandOwnerAllowFrom &&
    !commandOwnerAllowFrom.includes("*") &&
    !commandsAllowFromAccess.allowed &&
    !resolveDiscordOwnerAccess({
      allowFrom: commandOwnerAllowFrom,
      sender,
      allowNameMatching,
    }).ownerAllowed
  ) {
    const routeState = resolveDiscordNativeInteractionRouteState({
      cfg,
      accountId,
      guildId: interaction.guild?.id,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      directUserId: user.id,
      conversationId: rawChannelId,
      parentConversationId: threadParentId,
      threadBinding: isThreadChannel
        ? params.threadBindings?.getByThreadId(rawChannelId)
        : undefined,
    });
    const { ctxPayload } = await buildDiscordNativeInteractionContext({
      buildContext: params.buildContext,
      interaction,
      channelContext,
      route: routeState.effectiveRoute,
      boundSessionKey: routeState.boundSessionKey,
      sessionPrefix: params.sessionPrefix ?? "discord:slash",
      channelConfig,
      guildInfo,
      allowNameMatching,
      commandAuthorized: true,
      user,
      sender,
      prompt: "",
      commandArgs: {},
    });
    if (
      !resolveCommandAuthorization({ ctx: ctxPayload, cfg, commandAuthorized: true }).senderIsOwner
    ) {
      return false;
    }
  }
  return params.isPolicyCurrent?.() !== false;
}
