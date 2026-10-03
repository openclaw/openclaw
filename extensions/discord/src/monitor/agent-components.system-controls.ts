import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import { logDebug, logError } from "openclaw/plugin-sdk/logging-core";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import {
  Button,
  StringSelectMenu,
  type ButtonInteraction,
  type ComponentData,
  type StringSelectMenuInteraction,
} from "../internal/discord.js";
import {
  ackComponentInteraction,
  replyUnavailableComponentInteraction,
  resolveAgentComponentRoute,
} from "./agent-components-context.js";
import { parseAgentComponentData } from "./agent-components-data.js";
import { resolveInteractionContextWithDmAuth } from "./agent-components-dm-auth.js";
import { ensureAgentComponentInteractionAllowed } from "./agent-components-guild-auth.js";
import { resolveAgentComponentPolicyContext } from "./agent-components-live-policy.js";
import type {
  AgentComponentContext,
  AgentComponentMessageInteraction,
} from "./agent-components.types.js";

const AGENT_BUTTON_KEY = "agent";
const AGENT_SELECT_KEY = "agentsel";

type AgentSystemControlParams = {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  label: string;
  interactionComponentLabel: string;
  authorizationComponentLabel: string;
  invalidReply: string;
  unauthorizedReply: string;
  contextKeyPrefix: string;
  formatEventText: (params: { componentId: string; username: string; userId: string }) => string;
};

async function runAgentSystemControlInteraction(params: AgentSystemControlParams): Promise<void> {
  const parsed = parseAgentComponentData(params.data);
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    await replyUnavailableComponentInteraction(params.interaction, params.invalidReply);
    return;
  }

  const { componentId } = parsed;
  const ctx = await resolveAgentComponentPolicyContext(params);
  if (!ctx) {
    return;
  }
  const interactionCtx = await resolveInteractionContextWithDmAuth({
    ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.interactionComponentLabel,
    defer: false,
  });
  if (!interactionCtx) {
    return;
  }
  const {
    channelId,
    user,
    username,
    userId,
    replyOpts,
    rawGuildId,
    isDirectMessage,
    isGroupDm,
    memberRoleIds,
  } = interactionCtx;

  const allowed = await ensureAgentComponentInteractionAllowed({
    ctx,
    interaction: params.interaction,
    channelId,
    rawGuildId,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: params.authorizationComponentLabel,
    unauthorizedReply: params.unauthorizedReply,
  });
  if (!allowed) {
    return;
  }

  const route = resolveAgentComponentRoute({
    ctx,
    rawGuildId,
    memberRoleIds,
    isDirectMessage,
    isGroupDm,
    userId,
    channelId,
    parentId: allowed.parentId,
  });

  const eventText = params.formatEventText({ componentId, username, userId });
  logDebug(`${params.label}: enqueuing event for channel ${channelId}: ${eventText}`);

  enqueueRoutedSystemEvent(eventText, route, {
    // The immutable interaction ID identifies one occurrence, preserving repeat clicks while
    // deduplicating gateway replays of that same occurrence.
    contextKey: `${params.contextKeyPrefix}:${channelId}:${componentId}:${userId}:${params.interaction.id}`,
  });

  await ackComponentInteraction({
    interaction: params.interaction,
    replyOpts,
    label: params.label,
  });
}

class AgentComponentButton extends Button {
  override label = AGENT_BUTTON_KEY;
  customId = `${AGENT_BUTTON_KEY}:seed=1`;
  override style = ButtonStyle.Primary;
  constructor(private readonly ctx: AgentComponentContext) {
    super();
  }

  override async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    await runAgentSystemControlInteraction({
      ctx: this.ctx,
      interaction,
      data,
      label: "agent button",
      interactionComponentLabel: "button",
      authorizationComponentLabel: "button",
      invalidReply: "This button is no longer valid.",
      unauthorizedReply: "You are not authorized to use this button.",
      contextKeyPrefix: "discord:agent-button",
      formatEventText: ({ componentId, username, userId }) =>
        `[Discord component: ${componentId} clicked by ${username} (${userId})]`,
    });
  }
}

class AgentSelectMenu extends StringSelectMenu {
  customId = `${AGENT_SELECT_KEY}:seed=1`;
  options: APIStringSelectComponent["options"] = [];
  constructor(private readonly ctx: AgentComponentContext) {
    super();
  }

  override async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    const values = interaction.values ?? [];
    const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";
    await runAgentSystemControlInteraction({
      ctx: this.ctx,
      interaction,
      data,
      label: "agent select",
      interactionComponentLabel: "select menu",
      authorizationComponentLabel: "select",
      invalidReply: "This select menu is no longer valid.",
      unauthorizedReply: "You are not authorized to use this select menu.",
      contextKeyPrefix: "discord:agent-select",
      formatEventText: ({ componentId, username, userId }) =>
        `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`,
    });
  }
}

export function createAgentComponentButton(ctx: AgentComponentContext): Button {
  return new AgentComponentButton(ctx);
}

export function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu {
  return new AgentSelectMenu(ctx);
}
