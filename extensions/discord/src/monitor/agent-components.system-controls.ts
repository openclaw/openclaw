import { ComponentType, type APIMessageTopLevelComponent } from "discord-api-types/v10";
import { agentControlText } from "openclaw/plugin-sdk/interactive-runtime";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { parseDiscordAgentButtonValue } from "../component-custom-id.js";
import type {
  BaseMessageInteractiveComponent,
  BaseComponentInteraction,
} from "../internal/discord.js";
import { replyUnavailableComponentInteraction } from "./agent-components-context.js";
import { resolveInteractionCustomId } from "./agent-components-data.js";
import { resolveAuthorizedComponentInteraction } from "./agent-components-guild-auth.js";
import { dispatchDiscordComponentEvent } from "./agent-components.dispatch.js";
import { dispatchPluginDiscordInteractiveEvent } from "./agent-components.plugin-interactive.js";
import type {
  AgentComponentContext,
  AgentComponentMessageInteraction,
} from "./agent-components.types.js";

const AGENT_BUTTON_KEY = "agent";
const AGENT_SELECT_KEY = "agentsel";

// The tap consumes the controls; text and media stay on the message.
function withoutActionRows(components: unknown[]): APIMessageTopLevelComponent[] {
  return components.flatMap((component) => {
    const record = component as { type?: number; components?: unknown[] };
    if (record.type === ComponentType.ActionRow) {
      return [];
    }
    return [
      (Array.isArray(record.components)
        ? { ...record, components: withoutActionRows(record.components) }
        : record) as APIMessageTopLevelComponent,
    ];
  });
}

/** A stateless agent control: the marked value travels with the tap, so it never expires. */
async function runAgentControlInteraction(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  kind: "button" | "select";
  value: string | undefined;
}): Promise<void> {
  const { interaction, kind, value } = params;
  const label = `discord agent ${kind}`;
  const componentLabel = kind === "button" ? "button" : "select menu";
  const eventText = agentControlText(value);
  if (!value || !eventText) {
    logError(`${label}: failed to parse component data`);
    await replyUnavailableComponentInteraction(
      interaction,
      `This ${componentLabel} is no longer valid.`,
    );
    return;
  }
  const authorized = await resolveAuthorizedComponentInteraction({
    ctx: params.ctx,
    interaction,
    label,
    componentLabel,
    unauthorizedReply: `You are not authorized to use this ${componentLabel}.`,
  });
  if (!authorized) {
    return;
  }
  const messageId = interaction.message?.id;
  const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
    ...authorized,
    interaction,
    isAuthorizedSender: authorized.commandAuthorized,
    data: value,
    kind,
    messageId,
  });
  if (pluginDispatch === "handled") {
    return;
  }
  try {
    await interaction.update({
      components: withoutActionRows(interaction.rawData.message?.components ?? []),
    });
  } catch (err) {
    logError(`${label}: failed to consume the controls: ${String(err)}`);
  }
  // The conversation's session owns the tap, as if the user had typed the value.
  await dispatchDiscordComponentEvent({
    ...authorized,
    interaction,
    eventText,
    replyToId: messageId,
  });
}

export function createAgentComponentButton(
  ctx: AgentComponentContext,
): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.Button,
    customId: `${AGENT_BUTTON_KEY}:seed=1`,

    async run(interaction: BaseComponentInteraction): Promise<void> {
      await runAgentControlInteraction({
        ctx,
        interaction,
        kind: "button",
        value: parseDiscordAgentButtonValue(resolveInteractionCustomId(interaction)),
      });
    },
  };
}

export function createAgentSelectMenu(ctx: AgentComponentContext): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.StringSelect,
    customId: `${AGENT_SELECT_KEY}:seed=1`,

    async run(interaction: BaseComponentInteraction): Promise<void> {
      await runAgentControlInteraction({
        ctx,
        interaction,
        kind: "select",
        value: interaction.values.length === 1 ? interaction.values[0] : undefined,
      });
    },
  };
}
