import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import {
  replyUnavailableComponentInteraction,
  resolveDiscordChannelContext,
} from "./agent-components-context.js";
import { resolveInteractionContextWithDmAuth } from "./agent-components-dm-auth.js";
import { resolveAgentComponentPolicyContext } from "./agent-components-live-policy.js";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  ComponentInteractionContext,
  DiscordUser,
} from "./agent-components.types.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordChannelPolicyCommandAuthorizer,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";

function resolveComponentGuildContext(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  rawGuildId: string | undefined;
}) {
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: params.rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: params.channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.ctx.cfg.channels?.discord !== undefined,
    groupPolicy: params.ctx.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.ctx.cfg.channels?.defaults?.groupPolicy,
  });
  return {
    guildInfo,
    channelCtx,
    channelConfig,
    groupPolicy,
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
  };
}

async function ensureGuildComponentMemberAllowed(params: {
  interaction: AgentComponentInteraction;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  rawGuildId: string | undefined;
  channelConfig: ReturnType<typeof resolveDiscordChannelConfigWithFallback>;
  memberRoleIds: string[];
  user: DiscordUser;
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
  groupPolicy: "open" | "disabled" | "allowlist";
}) {
  const { interaction, guildInfo, channelConfig, user, componentLabel, unauthorizedReply } = params;

  if (!params.rawGuildId) {
    return true;
  }

  if (
    channelConfig?.enabled === false ||
    !resolveDiscordChannelPolicyCommandAuthorizer({
      groupPolicy: params.groupPolicy,
      guildInfo,
      channelConfig,
    }).allowed ||
    channelConfig?.allowed === false
  ) {
    await replyUnavailableComponentInteraction(interaction, unauthorizedReply);
    return false;
  }

  const { memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds: params.memberRoleIds,
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
  await replyUnavailableComponentInteraction(interaction, unauthorizedReply);
  return false;
}

async function ensureComponentUserAllowed(params: {
  allowedUsers: string[];
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
}) {
  const allowList = normalizeDiscordAllowList(params.allowedUsers, ["discord:", "user:", "pk:"]);
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
  await replyUnavailableComponentInteraction(params.interaction, params.unauthorizedReply);
  return false;
}

export async function ensureAgentComponentInteractionAllowed(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  user: DiscordUser;
  componentLabel: string;
  unauthorizedReply: string;
}) {
  const ctx = await resolveAgentComponentPolicyContext(params);
  if (!ctx) {
    return null;
  }
  const guildContext = resolveComponentGuildContext({ ...params, ctx });
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    ...params,
    ...guildContext,
    groupPolicy: guildContext.groupPolicy,
  });
  if (!memberAllowed) {
    return null;
  }
  if (ctx.isPolicyCurrent?.() === false) {
    await replyUnavailableComponentInteraction(
      params.interaction,
      "Access policy changed. Try this interaction again.",
    );
    return null;
  }
  return { parentId: guildContext.channelCtx.parentId };
}

export async function resolveAuthorizedComponentInteraction(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  label: string;
  componentLabel: string;
  unauthorizedReply: string;
  allowedUsers?: string[];
}) {
  const ctx = await resolveAgentComponentPolicyContext(params);
  if (!ctx) {
    return null;
  }
  const interactionCtx = await resolveInteractionContextWithDmAuth({
    ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.componentLabel,
  });
  if (!interactionCtx) {
    return null;
  }

  const guildContext = resolveComponentGuildContext({ ...params, ...interactionCtx, ctx });
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    ...params,
    ...interactionCtx,
    ...guildContext,
    groupPolicy: guildContext.groupPolicy,
  });
  if (!memberAllowed) {
    return null;
  }

  const commandAuthorized = await resolveComponentCommandAuthorized({
    ctx,
    interactionCtx,
    ...guildContext,
  });

  if (ctx.isPolicyCurrent?.() === false) {
    await replyUnavailableComponentInteraction(
      params.interaction,
      "Access policy changed. Try this interaction again.",
    );
    return null;
  }
  if (
    params.allowedUsers !== undefined &&
    !(await ensureComponentUserAllowed({
      ...params,
      allowedUsers: params.allowedUsers,
      user: interactionCtx.user,
      allowNameMatching: guildContext.allowNameMatching,
    }))
  ) {
    return null;
  }
  return {
    ctx,
    interactionCtx,
    channelCtx: guildContext.channelCtx,
    guildInfo: guildContext.guildInfo,
    commandAuthorized,
  };
}

export async function resolveComponentCommandAuthorized(params: {
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

  const sender = {
    id: interactionCtx.user.id,
    name: interactionCtx.user.username,
    tag: formatDiscordUserTag(interactionCtx.user),
  };
  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: ctx.allowFrom,
    sender,
    allowNameMatching: params.allowNameMatching,
  });

  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds: interactionCtx.memberRoleIds,
    sender,
    allowNameMatching: params.allowNameMatching,
  });
  return resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: true,
    authorizers: [
      { configured: ownerAllowList != null, allowed: ownerOk },
      { configured: hasAccessRestrictions, allowed: memberAllowed },
    ],
    modeWhenAccessGroupsOff: "configured",
  });
}
