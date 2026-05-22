import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import { Button, StringSelectMenu, type ButtonInteraction, type ComponentData, type StringSelectMenuInteraction } from "../internal/discord.js";
import { type AgentComponentContext } from "./agent-components-helpers.js";
export declare class AgentComponentButton extends Button {
    label: string;
    customId: string;
    style: ButtonStyle;
    private ctx;
    constructor(ctx: AgentComponentContext);
    run(interaction: ButtonInteraction, data: ComponentData): Promise<void>;
}
export declare class AgentSelectMenu extends StringSelectMenu {
    customId: string;
    options: APIStringSelectComponent["options"];
    private ctx;
    constructor(ctx: AgentComponentContext);
    run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void>;
}
export declare function createAgentComponentButton(ctx: AgentComponentContext): Button;
export declare function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu;
