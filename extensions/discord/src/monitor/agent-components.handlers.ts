import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logError } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordComponentEntry, resolveDiscordModalEntry } from "../components-registry.js";
import type { ButtonInteraction, ComponentData } from "../internal/discord.js";
import {
  type AgentComponentContext,
  type AgentComponentMessageInteraction,
  ensureComponentUserAllowed,
  ensureGuildComponentMemberAllowed,
  mapSelectValues,
  parseDiscordComponentData,
  resolveComponentCommandAuthorized,
  resolveDiscordChannelContext,
  resolveInteractionContextWithDmAuth,
  resolveInteractionCustomId,
  type ComponentInteractionContext,
} from "./agent-components-helpers.js";
import { dispatchDiscordComponentEvent } from "./agent-components.dispatch.js";
import { dispatchPluginDiscordInteractiveEvent } from "./agent-components.plugin-interactive.js";
import { resolveComponentGroupPolicy } from "./agent-components.policy.js";
import type { DiscordComponentControlHandlers } from "./agent-components.wildcard-controls.js";
import { resolveDiscordChannelConfigWithFallback, resolveDiscordGuildEntry } from "./allow-list.js";

let componentsRuntimePromise: Promise<typeof import("../components.js")> | undefined;

async function loadComponentsRuntime() {
  componentsRuntimePromise ??= import("../components.js");
  return await componentsRuntimePromise;
}

async function handleDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  componentLabel: string;
  values?: string[];
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    try {
      await params.interaction.reply({
        content: "This component is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const entry = resolveDiscordComponentEntry({ id: parsed.componentId, consume: false });
  if (!entry) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const interactionCtx = await resolveInteractionContextWithDmAuth({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.componentLabel,
    defer: false,
  });
  if (!interactionCtx) {
    return;
  }
  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const allowNameMatching = isDangerousNameMatchingEnabled(params.ctx.discordConfig);
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
  const unauthorizedReply = `You are not authorized to use this ${params.componentLabel}.`;
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply,
    allowNameMatching,
    groupPolicy: resolveComponentGroupPolicy(params.ctx),
  });
  if (!memberAllowed) {
    return;
  }

  const componentAllowed = await ensureComponentUserAllowed({
    entry,
    interaction: params.interaction,
    user,
    replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply,
    allowNameMatching,
  });
  if (!componentAllowed) {
    return;
  }
  const commandAuthorized = resolveComponentCommandAuthorized({
    ctx: params.ctx,
    interactionCtx,
    channelConfig,
    guildInfo,
    allowNameMatching,
  });

  const consumed = resolveDiscordComponentEntry({
    id: parsed.componentId,
    consume: !entry.reusable,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This component has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  if (consumed.kind === "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const values = params.values ? mapSelectValues(consumed, params.values) : undefined;
  if (consumed.callbackData) {
    const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
      ctx: params.ctx,
      interaction: params.interaction,
      interactionCtx,
      channelCtx,
      isAuthorizedSender: commandAuthorized,
      data: consumed.callbackData,
      kind: consumed.kind === "select" ? "select" : "button",
      values,
      messageId: consumed.messageId ?? params.interaction.message?.id,
    });
    if (pluginDispatch === "handled") {
      return;
    }
  }
  // Preserve explicit callback payloads for button fallbacks so Discord
  // behaves like Telegram when buttons carry synthetic command text. Select
  // fallbacks still need their chosen values in the synthesized event text.
  const eventText =
    (consumed.kind === "button" ? consumed.callbackData?.trim() : undefined) ||
    (await loadComponentsRuntime()).formatDiscordComponentEventText({
      kind: consumed.kind === "select" ? "select" : "button",
      label: consumed.label,
      values,
    });

  try {
    await params.interaction.reply({ content: "✓", ...replyOpts });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }

  await dispatchDiscordComponentEvent({
    ctx: params.ctx,
    interaction: params.interaction,
    interactionCtx,
    channelCtx,
    guildInfo,
    eventText,
    replyToId: consumed.messageId ?? params.interaction.message?.id,
    routeOverrides: {
      sessionKey: consumed.sessionKey,
      agentId: consumed.agentId,
      accountId: consumed.accountId,
    },
  });
}

async function handleDiscordModalTrigger(params: {
  ctx: AgentComponentContext;
  interaction: ButtonInteraction;
  data: ComponentData;
  label: string;
  interactionCtx?: ComponentInteractionContext;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse modal trigger data`);
    try {
      await params.interaction.reply({
        content: "This button is no longer valid.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }
  const entry = resolveDiscordComponentEntry({ id: parsed.componentId, consume: false });
  if (!entry || entry.kind !== "modal-trigger") {
    try {
      await params.interaction.reply({
        content: "This button has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const modalId = entry.modalId ?? parsed.modalId;
  if (!modalId) {
    try {
      await params.interaction.reply({
        content: "This form is no longer available.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const interactionCtx =
    params.interactionCtx ??
    (await resolveInteractionContextWithDmAuth({
      ctx: params.ctx,
      interaction: params.interaction,
      label: params.label,
      componentLabel: "form",
      defer: false,
    }));
  if (!interactionCtx) {
    return;
  }
  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const unauthorizedReply = "You are not authorized to use this form.";
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: "form",
    unauthorizedReply,
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
    groupPolicy: resolveComponentGroupPolicy(params.ctx),
  });
  if (!memberAllowed) {
    return;
  }

  const componentAllowed = await ensureComponentUserAllowed({
    entry,
    interaction: params.interaction,
    user,
    replyOpts,
    componentLabel: "form",
    unauthorizedReply,
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
  });
  if (!componentAllowed) {
    return;
  }

  const consumed = resolveDiscordComponentEntry({
    id: parsed.componentId,
    consume: !entry.reusable,
  });
  if (!consumed) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const resolvedModalId = consumed.modalId ?? modalId;
  const modalEntry = resolveDiscordModalEntry({ id: resolvedModalId, consume: false });
  if (!modalEntry) {
    try {
      await params.interaction.reply({
        content: "This form has expired.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  try {
    await params.interaction.showModal(
      (await loadComponentsRuntime()).createDiscordFormModal(modalEntry),
    );
  } catch (err) {
    logError(`${params.label}: failed to show modal: ${String(err)}`);
  }
}

export const discordComponentControlHandlers: DiscordComponentControlHandlers = {
  handleComponentEvent: handleDiscordComponentEvent,
  handleModalTrigger: handleDiscordModalTrigger,
};
