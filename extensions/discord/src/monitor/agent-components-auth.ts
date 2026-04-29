import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import type { DiscordComponentEntry } from "../components.js";
import {
  resolveComponentInteractionContext,
  resolveDiscordChannelContext,
} from "./agent-components-context.js";
import {
  readStoreAllowFromForDmPolicy,
  upsertChannelPairingRequest,
} from "./agent-components-helpers.runtime.js";
import {
  type AgentComponentContext,
  type AgentComponentInteraction,
  type ComponentInteractionContext,
  type DiscordChannelContext,
  type DiscordUser,
} from "./agent-components.types.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";

async function replySilently(
  interaction: AgentComponentInteraction,
  params: { content: string; ephemeral?: boolean },
) {
  try {
    await interaction.reply(params);
  } catch {}
}

export async function ensureGuildComponentMemberAllowed(params: {
  interaction: AgentComponentInteraction;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  channelId: string;
  rawGuildId: string | undefined;
  channelCtx: DiscordChannelContext;
  memberRoleIds: string[];
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
  groupPolicy: "open" | "disabled" | "allowlist";
}) {
  const {
    interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel,
    unauthorizedReply,
  } = params;

  if (!rawGuildId) {
    return true;
  }

  const replyUnauthorized = async () => {
    await replySilently(interaction, { content: unauthorizedReply, ...replyOpts });
  };

  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });

  if (channelConfig?.enabled === false) {
    await replyUnauthorized();
    return false;
  }
  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    await replyUnauthorized();
    return false;
  }
  if (channelConfig?.allowed === false) {
    await replyUnauthorized();
    return false;
  }

  const { memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender: {
      id: user.id,
      name: user.username,
      tag: user.discriminator ? `${user.username}#${user.discriminator}` : undefined,
    },
    allowNameMatching: params.allowNameMatching,
  });
  if (memberAllowed) {
    return true;
  }

  logVerbose(`agent ${componentLabel}: blocked user ${user.id} (not in users/roles allowlist)`);
  await replyUnauthorized();
  return false;
}

export async function ensureComponentUserAllowed(params: {
  entry: DiscordComponentEntry;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
}) {
  const allowList = normalizeDiscordAllowList(params.entry.allowedUsers, [
    "discord:",
    "user:",
    "pk:",
  ]);
  if (!allowList) {
    return true;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: {
      id: params.user.id,
      name: params.user.username,
      tag: formatDiscordUserTag(params.user),
    },
    allowNameMatching: params.allowNameMatching,
  });
  if (match.allowed) {
    return true;
  }

  logVerbose(
    `discord component ${params.componentLabel}: blocked user ${params.user.id} (not in allowedUsers)`,
  );
  await replySilently(params.interaction, {
    content: params.unauthorizedReply,
    ...params.replyOpts,
  });
  return false;
}

export async function ensureAgentComponentInteractionAllowed(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
}) {
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: params.rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId: params.channelId,
    rawGuildId: params.rawGuildId,
    channelCtx,
    memberRoleIds: params.memberRoleIds,
    user: params.user,
    replyOpts: params.replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply: params.unauthorizedReply,
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
    groupPolicy: resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: params.ctx.cfg.channels?.discord !== undefined,
      groupPolicy: params.ctx.discordConfig?.groupPolicy,
      defaultGroupPolicy: params.ctx.cfg.channels?.defaults?.groupPolicy,
    }).groupPolicy,
  });
  if (!memberAllowed) {
    return null;
  }
  return { parentId: channelCtx.parentId };
}

async function ensureDmComponentAuthorized(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  componentLabel: string;
  replyOpts: { ephemeral?: boolean };
}) {
  const { ctx, interaction, user, componentLabel, replyOpts } = params;
  const allowFromPrefixes = ["discord:", "user:", "pk:"];
  const resolveAllowMatch = (entries: string[]) => {
    const allowList = normalizeDiscordAllowList(entries, allowFromPrefixes);
    return allowList
      ? resolveDiscordAllowListMatch({
          allowList,
          candidate: {
            id: user.id,
            name: user.username,
            tag: formatDiscordUserTag(user),
          },
          allowNameMatching: isDangerousNameMatchingEnabled(ctx.discordConfig),
        })
      : { allowed: false };
  };
  const dmPolicy = ctx.dmPolicy ?? "pairing";
  if (dmPolicy === "disabled") {
    logVerbose(`agent ${componentLabel}: blocked (DM policy disabled)`);
    await replySilently(interaction, { content: "DM interactions are disabled.", ...replyOpts });
    return false;
  }
  if (dmPolicy === "allowlist") {
    const allowMatch = resolveAllowMatch(ctx.allowFrom ?? []);
    if (allowMatch.allowed) {
      return true;
    }
    logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
    await replySilently(interaction, {
      content: `You are not authorized to use this ${componentLabel}.`,
      ...replyOpts,
    });
    return false;
  }

  const storeAllowFrom =
    dmPolicy === "open"
      ? []
      : await readStoreAllowFromForDmPolicy({
          provider: "discord",
          accountId: ctx.accountId,
          dmPolicy,
        });
  const allowMatch = resolveAllowMatch([...(ctx.allowFrom ?? []), ...storeAllowFrom]);
  if (allowMatch.allowed) {
    return true;
  }

  if (dmPolicy === "pairing") {
    const pairingResult = await createChannelPairingChallengeIssuer({
      channel: "discord",
      upsertPairingRequest: async ({ id, meta }) => {
        return await upsertChannelPairingRequest({
          channel: "discord",
          id,
          accountId: ctx.accountId,
          meta,
        });
      },
    })({
      senderId: user.id,
      senderIdLine: `Your Discord user id: ${user.id}`,
      meta: {
        tag: formatDiscordUserTag(user),
        name: user.username,
      },
      sendPairingReply: async (text) => {
        await interaction.reply({
          content: text,
          ...replyOpts,
        });
      },
    });
    if (!pairingResult.created) {
      await replySilently(interaction, {
        content: "Pairing already requested. Ask the bot owner to approve your code.",
        ...replyOpts,
      });
    }
    return false;
  }

  logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
  await replySilently(interaction, {
    content: `You are not authorized to use this ${componentLabel}.`,
    ...replyOpts,
  });
  return false;
}

async function ensureGroupDmComponentAuthorized(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  componentLabel: string;
  replyOpts: { ephemeral?: boolean };
}) {
  const { ctx, interaction, channelId, componentLabel, replyOpts } = params;
  const groupDmEnabled = ctx.discordConfig?.dm?.groupEnabled ?? false;
  if (!groupDmEnabled) {
    logVerbose(`agent ${componentLabel}: blocked group dm ${channelId} (group DMs disabled)`);
    await replySilently(interaction, {
      content: "Group DM interactions are disabled.",
      ...replyOpts,
    });
    return false;
  }

  const channelCtx = resolveDiscordChannelContext(interaction);
  const allowed = resolveGroupDmAllow({
    channels: ctx.discordConfig?.dm?.groupChannels,
    channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
  });
  if (allowed) {
    return true;
  }

  logVerbose(`agent ${componentLabel}: blocked group dm ${channelId} (not allowlisted)`);
  await replySilently(interaction, {
    content: `You are not authorized to use this ${componentLabel}.`,
    ...replyOpts,
  });
  return false;
}

export async function resolveInteractionContextWithDmAuth(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  label: string;
  componentLabel: string;
  defer?: boolean;
}) {
  const interactionCtx = await resolveComponentInteractionContext({
    interaction: params.interaction,
    label: params.label,
    defer: params.defer,
  });
  if (!interactionCtx) {
    return null;
  }
  if (interactionCtx.isDirectMessage) {
    const authorized = await ensureDmComponentAuthorized({
      ctx: params.ctx,
      interaction: params.interaction,
      user: interactionCtx.user,
      componentLabel: params.componentLabel,
      replyOpts: interactionCtx.replyOpts,
    });
    if (!authorized) {
      return null;
    }
  }
  if (interactionCtx.isGroupDm) {
    const authorized = await ensureGroupDmComponentAuthorized({
      ctx: params.ctx,
      interaction: params.interaction,
      channelId: interactionCtx.channelId,
      componentLabel: params.componentLabel,
      replyOpts: interactionCtx.replyOpts,
    });
    if (!authorized) {
      return null;
    }
  }
  return interactionCtx;
}

export function resolveComponentCommandAuthorized(params: {
  ctx: AgentComponentContext;
  interactionCtx: ComponentInteractionContext;
  channelConfig: ReturnType<typeof resolveDiscordChannelConfigWithFallback>;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  allowNameMatching: boolean;
}) {
  const { ctx, interactionCtx, channelConfig, guildInfo } = params;
  if (interactionCtx.isDirectMessage) {
    return true;
  }

  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: ctx.allowFrom,
    sender: {
      id: interactionCtx.user.id,
      name: interactionCtx.user.username,
      tag: formatDiscordUserTag(interactionCtx.user),
    },
    allowNameMatching: params.allowNameMatching,
  });

  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds: interactionCtx.memberRoleIds,
    sender: {
      id: interactionCtx.user.id,
      name: interactionCtx.user.username,
      tag: formatDiscordUserTag(interactionCtx.user),
    },
    allowNameMatching: params.allowNameMatching,
  });
  const useAccessGroups = ctx.cfg.commands?.useAccessGroups !== false;
  const authorizers = useAccessGroups
    ? [
        { configured: ownerAllowList != null, allowed: ownerOk },
        { configured: hasAccessRestrictions, allowed: memberAllowed },
      ]
    : [{ configured: hasAccessRestrictions, allowed: memberAllowed }];

  return resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    authorizers,
    modeWhenAccessGroupsOff: "configured",
  });
}
