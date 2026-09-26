import { Modal, type BaseMessageInteractiveComponent } from "../internal/discord.js";
import { discordComponentControlHandlers } from "./agent-components.handlers.js";
import { DiscordComponentModal } from "./agent-components.modal.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
} from "./agent-components.system-controls.js";
import type { AgentComponentContext } from "./agent-components.types.js";
import {
  createDiscordComponentButtonControl,
  createDiscordComponentChannelSelectControl,
  createDiscordComponentMentionableSelectControl,
  createDiscordComponentRoleSelectControl,
  createDiscordComponentStringSelectControl,
  createDiscordComponentUserSelectControl,
} from "./agent-components.wildcard-controls.js";

type ComponentFactory = (ctx: AgentComponentContext) => BaseMessageInteractiveComponent;

export const createAgentComponentControls = [
  createAgentComponentButton,
  createAgentSelectMenu,
] satisfies readonly ComponentFactory[];

export const createDiscordComponentControls = [
  createDiscordComponentButtonControl,
  createDiscordComponentStringSelectControl,
  createDiscordComponentUserSelectControl,
  createDiscordComponentRoleSelectControl,
  createDiscordComponentMentionableSelectControl,
  createDiscordComponentChannelSelectControl,
].map(
  (createControl): ComponentFactory =>
    (ctx) =>
      createControl(ctx, discordComponentControlHandlers),
);

export function createDiscordComponentModal(ctx: AgentComponentContext): Modal {
  return new DiscordComponentModal(ctx);
}
