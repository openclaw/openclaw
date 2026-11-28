import {
  ComponentType,
  type APIComponentInContainer,
  type APIComponentInMessageActionRow,
  type APIMessageTopLevelComponent,
} from "discord-api-types/v10";
import { agentControlText } from "openclaw/plugin-sdk/interactive-runtime";
import { logError } from "openclaw/plugin-sdk/logging-core";
import {
  isDiscordAgentControlCustomId,
  parseDiscordAgentButtonCustomId,
} from "../component-custom-id.js";
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

type MessageComponent =
  | APIMessageTopLevelComponent
  | APIComponentInContainer
  | APIComponentInMessageActionRow;

// The tap consumes the agent's controls by disabling them; text, media, links and other
// controls stay, and the message never becomes empty.
function withAgentControlsDisabled<T extends MessageComponent>(components: readonly T[]): T[] {
  return components.map((component): T => {
    if ("custom_id" in component && isDiscordAgentControlCustomId(component.custom_id)) {
      return { ...component, disabled: true };
    }
    if (component.type === ComponentType.ActionRow) {
      return { ...component, components: withAgentControlsDisabled(component.components) };
    }
    if (component.type === ComponentType.Container) {
      return { ...component, components: withAgentControlsDisabled(component.components) };
    }
    return component;
  });
}

// Plugin handlers get the selected option labels, as for registry selects.
function selectedOptionLabels(
  components: readonly MessageComponent[],
  customId: string,
  values: readonly string[],
): string[] | undefined {
  for (const component of components) {
    if (component.type === ComponentType.StringSelect && component.custom_id === customId) {
      const labels = new Map(component.options.map((option) => [option.value, option.label]));
      return values.map((value) => labels.get(value) ?? value);
    }
    if (component.type === ComponentType.ActionRow || component.type === ComponentType.Container) {
      const found = selectedOptionLabels(component.components, customId, values);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** A stateless agent control: the marked value travels with the tap, so it never expires. */
async function runAgentControlInteraction(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  kind: "button" | "select";
  value: string | undefined;
  reusable?: boolean;
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
  const components = interaction.rawData.message?.components ?? [];
  // Consume before any handler runs, so a plugin-handled tap is single use too.
  let consumed = false;
  if (!params.reusable) {
    try {
      await interaction.update({ components: withAgentControlsDisabled(components) });
      consumed = true;
    } catch (err) {
      logError(`${label}: failed to consume the controls: ${String(err)}`);
    }
  }
  const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
    ...authorized,
    interaction,
    isAuthorizedSender: authorized.commandAuthorized,
    data: value,
    kind,
    values:
      kind === "select"
        ? selectedOptionLabels(
            components,
            resolveInteractionCustomId(interaction) ?? "",
            interaction.values,
          )
        : undefined,
    messageId,
    sourceAnswered: consumed,
  });
  if (pluginDispatch === "handled") {
    return;
  }
  if (!consumed) {
    try {
      await interaction.acknowledge();
    } catch (err) {
      logError(`${label}: failed to answer the interaction: ${String(err)}`);
    }
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
      const parsed = parseDiscordAgentButtonCustomId(resolveInteractionCustomId(interaction));
      await runAgentControlInteraction({
        ctx,
        interaction,
        kind: "button",
        value: parsed?.value,
        reusable: parsed?.reusable,
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
