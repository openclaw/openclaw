import { ComponentType } from "discord-api-types/v10";
import { parseDiscordComponentCustomIdForInteraction } from "../component-custom-id.js";
import type { DiscordComponentSelectType } from "../components.types.js";
import type {
  BaseMessageInteractiveComponent,
  BaseComponentInteraction,
  ComponentData,
} from "../internal/discord.js";
import { parseDiscordComponentData, resolveInteractionCustomId } from "./agent-components-data.js";
import type {
  AgentComponentContext,
  AgentComponentMessageInteraction,
} from "./agent-components.types.js";

export type DiscordComponentControlHandlers = {
  handleComponentEvent: (params: {
    ctx: AgentComponentContext;
    interaction: AgentComponentMessageInteraction;
    data: ComponentData;
    componentLabel: string;
    values?: string[];
    label: string;
  }) => Promise<void>;
  handleModalTrigger: (params: {
    ctx: AgentComponentContext;
    interaction: BaseComponentInteraction;
    data: ComponentData;
    label: string;
  }) => Promise<void>;
};

type SelectControlSpec = {
  type: ComponentType;
  kind: DiscordComponentSelectType;
};

const SELECT_CONTROLS = [
  { type: ComponentType.StringSelect, kind: "string" },
  { type: ComponentType.UserSelect, kind: "user" },
  { type: ComponentType.RoleSelect, kind: "role" },
  { type: ComponentType.MentionableSelect, kind: "mentionable" },
  { type: ComponentType.ChannelSelect, kind: "channel" },
] satisfies SelectControlSpec[];

function createDiscordComponentSelectControl(
  spec: SelectControlSpec,
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): BaseMessageInteractiveComponent {
  return {
    customIdParser: parseDiscordComponentCustomIdForInteraction,
    type: spec.type,
    customId: `__openclaw_discord_component_${spec.kind}_select_wildcard__`,

    async run(interaction: AgentComponentMessageInteraction, data: ComponentData): Promise<void> {
      await handlers.handleComponentEvent({
        ctx,
        interaction,
        data,
        componentLabel: spec.kind === "string" ? "select menu" : `${spec.kind} select`,
        label:
          spec.kind === "string"
            ? "discord component select"
            : `discord component ${spec.kind} select`,
        values: interaction.values ?? [],
      });
    },
  };
}

function createDiscordComponentButton(
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.Button,
    customId: "__openclaw_discord_component_button_wildcard__",
    customIdParser: parseDiscordComponentCustomIdForInteraction,

    async run(interaction: BaseComponentInteraction, data: ComponentData): Promise<void> {
      const parsed = parseDiscordComponentData(data, resolveInteractionCustomId(interaction));
      if (parsed?.modalId) {
        await handlers.handleModalTrigger({
          ctx,
          interaction,
          data,
          label: "discord component modal",
        });
        return;
      }
      await handlers.handleComponentEvent({
        ctx,
        interaction,
        data,
        componentLabel: "button",
        label: "discord component button",
      });
    },
  };
}

export const discordComponentControlFactories = [
  createDiscordComponentButton,
  ...SELECT_CONTROLS.map(
    (spec) => (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) =>
      createDiscordComponentSelectControl(spec, ctx, handlers),
  ),
];
