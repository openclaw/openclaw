import { readChannelIngressStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  replyUnavailableComponentInteraction,
  resolveComponentInteractionContext,
  resolveDiscordChannelContext,
} from "./agent-components-context.js";
import { resolveAgentComponentPolicyContext } from "./agent-components-live-policy.js";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  DiscordUser,
} from "./agent-components.types.js";
import { resolveGroupDmAllow } from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { formatDiscordUserTag } from "./format.js";

async function ensureDmComponentAuthorized(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  componentLabel: string;
}) {
  const { ctx, interaction, user, componentLabel } = params;
  const dmPolicy = ctx.dmPolicy ?? "pairing";
  if (ctx.discordConfig?.dm?.enabled === false || dmPolicy === "disabled") {
    logVerbose(`agent ${componentLabel}: blocked (DM policy disabled)`);
    await replyUnavailableComponentInteraction(interaction, "DM interactions are disabled.");
    return false;
  }
  const access = await resolveDiscordDmCommandAccess({
    accountId: ctx.accountId,
    dmPolicy,
    configuredAllowFrom: ctx.allowFrom ?? [],
    sender: {
      id: user.id,
      name: user.username,
      tag: formatDiscordUserTag(user),
    },
    allowNameMatching: isDangerousNameMatchingEnabled(ctx.discordConfig),
    cfg: ctx.cfg,
    token: ctx.token,
    readStoreAllowFrom: async ({ accountId, dmPolicy: dmPolicyLocal }) =>
      await readChannelIngressStoreAllowFromForDmPolicy({
        provider: "discord",
        accountId,
        dmPolicy: dmPolicyLocal,
      }),
    eventKind: "button",
  });
  if (ctx.isPolicyCurrent?.() === false) {
    await replyUnavailableComponentInteraction(
      interaction,
      "Access policy changed. Try this interaction again.",
    );
    return false;
  }
  if (access.senderAccess.decision === "allow") {
    return true;
  }
  if (access.senderAccess.decision !== "pairing") {
    logVerbose(`agent ${componentLabel}: blocked DM user ${user.id} (not in allowFrom)`);
    await replyUnavailableComponentInteraction(
      interaction,
      `You are not authorized to use this ${componentLabel}.`,
    );
    return false;
  }
  const pairingResult = await createChannelPairingChallengeIssuer({
    channel: "discord",
    accountId: ctx.accountId,
    upsertPairingRequest: ({ id, meta }) =>
      upsertChannelPairingRequest({
        channel: "discord",
        id,
        accountId: ctx.accountId,
        meta,
      }),
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
        ephemeral: true,
      });
    },
  });
  if (!pairingResult.created) {
    await replyUnavailableComponentInteraction(
      interaction,
      "Pairing already requested. Ask the bot owner to approve your code.",
    );
  }
  return false;
}

async function ensureGroupDmComponentAuthorized(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  componentLabel: string;
}) {
  const { ctx, interaction, channelId, componentLabel } = params;
  const groupDmEnabled = ctx.discordConfig?.dm?.groupEnabled ?? false;
  if (!groupDmEnabled) {
    logVerbose(`agent ${componentLabel}: blocked group dm ${channelId} (group DMs disabled)`);
    await replyUnavailableComponentInteraction(interaction, "Group DM interactions are disabled.");
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
  await replyUnavailableComponentInteraction(
    interaction,
    `You are not authorized to use this ${componentLabel}.`,
  );
  return false;
}

export async function resolveInteractionContextWithDmAuth(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  label: string;
  componentLabel: string;
}) {
  const ctx = await resolveAgentComponentPolicyContext(params);
  if (!ctx) {
    return null;
  }
  const interactionCtx = await resolveComponentInteractionContext({
    interaction: params.interaction,
    label: params.label,
  });
  if (!interactionCtx) {
    return null;
  }
  if (ctx.isPolicyCurrent?.() === false) {
    await replyUnavailableComponentInteraction(
      params.interaction,
      "Access policy changed. Try this interaction again.",
    );
    return null;
  }
  const authorize = interactionCtx.isDirectMessage
    ? ensureDmComponentAuthorized
    : interactionCtx.isGroupDm
      ? ensureGroupDmComponentAuthorized
      : undefined;
  if (authorize && !(await authorize({ ...params, ...interactionCtx, ctx }))) {
    return null;
  }
  return interactionCtx;
}
