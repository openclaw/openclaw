import { ComponentType } from "discord-api-types/v10";
import { logDebug, logError } from "openclaw/plugin-sdk/logging-core";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type {
  BaseMessageInteractiveComponent,
  BaseComponentInteraction,
  ComponentData,
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

async function runAgentSystemControlInteraction(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  kind: "button" | "select";
  formatEventText: (params: { componentId: string; username: string; userId: string }) => string;
}): Promise<void> {
  const label = `agent ${params.kind}`;
  const componentLabel = params.kind === "button" ? "button" : "select menu";
  const parsed = parseAgentComponentData(params.data);
  if (!parsed) {
    logError(`${label}: failed to parse component data`);
    await replyUnavailableComponentInteraction(
      params.interaction,
      `This ${componentLabel} is no longer valid.`,
    );
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
    label,
    componentLabel,
  });
  if (!interactionCtx) {
    return;
  }
  const { channelId, username, userId } = interactionCtx;

  const allowed = await ensureAgentComponentInteractionAllowed({
    ...params,
    ...interactionCtx,
    ctx,
    componentLabel: params.kind,
    unauthorizedReply: `You are not authorized to use this ${componentLabel}.`,
  });
  if (!allowed) {
    return;
  }

  const route = resolveAgentComponentRoute({
    ctx,
    ...interactionCtx,
    parentId: allowed.parentId,
  });

  const eventText = params.formatEventText({ componentId, username, userId });
  logDebug(
    `${label}: enqueuing event for channel ${channelId} interaction=${params.interaction.id}`,
  );

  enqueueRoutedSystemEvent(eventText, route, {
    // The immutable interaction ID identifies one occurrence, preserving repeat clicks while
    // deduplicating gateway replays of that same occurrence.
    contextKey: `discord:agent-${params.kind}:${channelId}:${componentId}:${userId}:${params.interaction.id}`,
  });

  await ackComponentInteraction({
    interaction: params.interaction,
    label,
  });
}

export function createAgentComponentButton(
  ctx: AgentComponentContext,
): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.Button,
    customId: `${AGENT_BUTTON_KEY}:seed=1`,

    async run(interaction: BaseComponentInteraction, data: ComponentData): Promise<void> {
      await runAgentSystemControlInteraction({
        ctx,
        interaction,
        data,
        kind: "button",
        formatEventText: ({ componentId, username, userId }) =>
          `[Discord component: ${componentId} clicked by ${username} (${userId})]`,
      });
    },
  };
}

export function createAgentSelectMenu(ctx: AgentComponentContext): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.StringSelect,
    customId: `${AGENT_SELECT_KEY}:seed=1`,

    async run(interaction: BaseComponentInteraction, data: ComponentData): Promise<void> {
      const values = interaction.values ?? [];
      const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";
      await runAgentSystemControlInteraction({
        ctx,
        interaction,
        data,
        kind: "select",
        formatEventText: ({ componentId, username, userId }) =>
          `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`,
      });
    },
  };
}
