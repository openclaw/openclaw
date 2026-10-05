import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { resolveDiscordChannelContext } from "./agent-components-context.js";
import { resolveInteractionContextWithDmAuth } from "./agent-components-dm-auth.js";
import { resolveAgentComponentPolicyContext } from "./agent-components-live-policy.js";
import { replySilently } from "./agent-components-reply.js";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  ComponentInteractionContext,
  DiscordChannelContext,
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

function resolveComponentRuntimeGroupPolicy(ctx: AgentComponentContext) {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: ctx.cfg.channels?.discord !== undefined,
    groupPolicy: ctx.discordConfig?.groupPolicy,
    defaultGroupPolicy: ctx.cfg.channels?.defaults?.groupPolicy,
  }).groupPolicy;
}

async function ensureGuildComponentMemberAllowed(params: {
  interaction: AgentComponentInteraction;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  channelId: string;
  rawGuildId: string | undefined;
  channelCtx: DiscordChannelContext;
  memberRoleIds: string[];
  user: DiscordUser;
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
  groupPolicy: "open" | "disabled" | "allowlist";
}) {
  const { interaction, guildInfo, user, componentLabel, unauthorizedReply } = params;

  if (!params.rawGuildId) {
    return true;
  }

  const replyUnauthorized = async () => {
    await replySilently(interaction, { content: unauthorizedReply, ephemeral: true });
  };

  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: params.channelId,
    channelName: params.channelCtx.channelName,
    channelSlug: params.channelCtx.channelSlug,
    parentId: params.channelCtx.parentId,
    parentName: params.channelCtx.parentName,
    parentSlug: params.channelCtx.parentSlug,
    scope: params.channelCtx.isThread ? "thread" : "channel",
  });

  if (
    channelConfig?.enabled === false ||
    !resolveDiscordChannelPolicyCommandAuthorizer({
      groupPolicy: params.groupPolicy,
      guildInfo,
      channelConfig,
    }).allowed ||
    channelConfig?.allowed === false
  ) {
    await replyUnauthorized();
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
  await replyUnauthorized();
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
  await replySilently(params.interaction, {
    content: params.unauthorizedReply,
    ephemeral: true,
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
  componentLabel: string;
  unauthorizedReply: string;
}) {
  const ctx = await resolveAgentComponentPolicyContext(params);
  if (!ctx) {
    return null;
  }
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: params.rawGuildId,
    guildEntries: ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    ...params,
    guildInfo,
    channelCtx,
    allowNameMatching: isDangerousNameMatchingEnabled(ctx.discordConfig),
    groupPolicy: resolveComponentRuntimeGroupPolicy(ctx),
  });
  if (!memberAllowed) {
    return null;
  }
  if (ctx.isPolicyCurrent?.() === false) {
    await replySilently(params.interaction, {
      content: "Access policy changed. Try this interaction again.",
      ephemeral: true,
    });
    return null;
  }
  return { parentId: channelCtx.parentId };
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

  const { channelId, user, rawGuildId } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: rawGuildId,
    guildEntries: ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const allowNameMatching = isDangerousNameMatchingEnabled(ctx.discordConfig);
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
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    ...params,
    ...interactionCtx,
    guildInfo,
    channelCtx,
    allowNameMatching,
    groupPolicy: resolveComponentRuntimeGroupPolicy(ctx),
  });
  if (!memberAllowed) {
    return null;
  }

  const commandAuthorized = await resolveComponentCommandAuthorized({
    ctx,
    interactionCtx,
    channelConfig,
    guildInfo,
    allowNameMatching,
  });

  if (ctx.isPolicyCurrent?.() === false) {
    await replySilently(params.interaction, {
      content: "Access policy changed. Try this interaction again.",
      ephemeral: true,
    });
    return null;
  }
  if (
    params.allowedUsers !== undefined &&
    !(await ensureComponentUserAllowed({
      ...params,
      allowedUsers: params.allowedUsers,
      user,
      allowNameMatching,
    }))
  ) {
    return null;
  }
  return {
    ctx,
    interactionCtx,
    channelCtx,
    guildInfo,
    channelConfig,
    allowNameMatching,
    commandAuthorized,
    user,
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
