import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import { parseDiscordComponentCustomIdForInteraction } from "../component-custom-id.js";
import {
  Button,
  ChannelSelectMenu,
  MentionableSelectMenu,
  RoleSelectMenu,
  StringSelectMenu,
  UserSelectMenu,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ComponentData,
  type MentionableSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "../internal/discord.js";
import {
  parseDiscordComponentData,
  resolveInteractionContextWithDmAuth,
  resolveInteractionCustomId,
  type AgentComponentContext,
  type AgentComponentMessageInteraction,
  type ComponentInteractionContext,
} from "./agent-components-helpers.js";

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
    interaction: ButtonInteraction;
    data: ComponentData;
    label: string;
    interactionCtx?: ComponentInteractionContext;
  }) => Promise<void>;
};

class DiscordComponentButton extends Button {
  label = "component";
  customId = "__openclaw_discord_component_button_wildcard__";
  style = ButtonStyle.Primary;
  customIdParser = parseDiscordComponentCustomIdForInteraction;

  constructor(
    private ctx: AgentComponentContext,
    private handlers: DiscordComponentControlHandlers,
  ) {
    super();
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseDiscordComponentData(data, resolveInteractionCustomId(interaction));
    if (parsed?.modalId) {
      const interactionCtx = await resolveInteractionContextWithDmAuth({
        ctx: this.ctx,
        interaction,
        label: "discord component button",
        componentLabel: "form",
        defer: false,
      });
      if (!interactionCtx) {
        return;
      }
      await this.handlers.handleModalTrigger({
        ctx: this.ctx,
        interaction,
        data,
        label: "discord component modal",
        interactionCtx,
      });
      return;
    }
    await this.handlers.handleComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "button",
      label: "discord component button",
    });
  }
}

class DiscordComponentStringSelect extends StringSelectMenu {
  customId = "__openclaw_discord_component_string_select_wildcard__";
  options: APIStringSelectComponent["options"] = [];
  customIdParser = parseDiscordComponentCustomIdForInteraction;

  constructor(
    private ctx: AgentComponentContext,
    private handlers: DiscordComponentControlHandlers,
  ) {
    super();
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    await this.handlers.handleComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "select menu",
      label: "discord component select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentUserSelect extends UserSelectMenu {
  customId = "__openclaw_discord_component_user_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForInteraction;

  constructor(
    private ctx: AgentComponentContext,
    private handlers: DiscordComponentControlHandlers,
  ) {
    super();
  }

  async run(interaction: UserSelectMenuInteraction, data: ComponentData): Promise<void> {
    await this.handlers.handleComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "user select",
      label: "discord component user select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentRoleSelect extends RoleSelectMenu {
  customId = "__openclaw_discord_component_role_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForInteraction;

  constructor(
    private ctx: AgentComponentContext,
    private handlers: DiscordComponentControlHandlers,
  ) {
    super();
  }

  async run(interaction: RoleSelectMenuInteraction, data: ComponentData): Promise<void> {
    await this.handlers.handleComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "role select",
      label: "discord component role select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentMentionableSelect extends MentionableSelectMenu {
  customId = "__openclaw_discord_component_mentionable_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForInteraction;

  constructor(
    private ctx: AgentComponentContext,
    private handlers: DiscordComponentControlHandlers,
  ) {
    super();
  }

  async run(interaction: MentionableSelectMenuInteraction, data: ComponentData): Promise<void> {
    await this.handlers.handleComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "mentionable select",
      label: "discord component mentionable select",
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentChannelSelect extends ChannelSelectMenu {
  customId = "__openclaw_discord_component_channel_select_wildcard__";
  customIdParser = parseDiscordComponentCustomIdForInteraction;

  constructor(
    private ctx: AgentComponentContext,
    private handlers: DiscordComponentControlHandlers,
  ) {
    super();
  }

  async run(interaction: ChannelSelectMenuInteraction, data: ComponentData): Promise<void> {
    await this.handlers.handleComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "channel select",
      label: "discord component channel select",
      values: interaction.values ?? [],
    });
  }
}

export function createDiscordComponentButtonControl(
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): Button {
  return new DiscordComponentButton(ctx, handlers);
}

export function createDiscordComponentStringSelectControl(
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): StringSelectMenu {
  return new DiscordComponentStringSelect(ctx, handlers);
}

export function createDiscordComponentUserSelectControl(
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): UserSelectMenu {
  return new DiscordComponentUserSelect(ctx, handlers);
}

export function createDiscordComponentRoleSelectControl(
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): RoleSelectMenu {
  return new DiscordComponentRoleSelect(ctx, handlers);
}

export function createDiscordComponentMentionableSelectControl(
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): MentionableSelectMenu {
  return new DiscordComponentMentionableSelect(ctx, handlers);
}

export function createDiscordComponentChannelSelectControl(
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): ChannelSelectMenu {
  return new DiscordComponentChannelSelect(ctx, handlers);
}
