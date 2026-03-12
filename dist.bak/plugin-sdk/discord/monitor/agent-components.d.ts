import { Button, ChannelSelectMenu, MentionableSelectMenu, Modal, RoleSelectMenu, StringSelectMenu, UserSelectMenu, type ButtonInteraction, type ComponentData, type StringSelectMenuInteraction } from "@buape/carbon";
import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordAccountConfig } from "../../config/types.discord.js";
import { type RuntimeEnv } from "../../runtime.js";
import { type DiscordGuildEntryResolved } from "./allow-list.js";
export type AgentComponentContext = {
    cfg: OpenClawConfig;
    accountId: string;
    discordConfig?: DiscordAccountConfig;
    runtime?: RuntimeEnv;
    token?: string;
    guildEntries?: Record<string, DiscordGuildEntryResolved>;
    /** DM allowlist (from allowFrom config; legacy: dm.allowFrom) */
    allowFrom?: string[];
    /** DM policy (default: "pairing") */
    dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
};
/**
 * Build agent button custom ID: agent:componentId=<id>
 * The channelId is NOT embedded in customId - we use interaction.rawData.channel_id instead
 * to prevent channel spoofing attacks.
 *
 * Carbon's customIdParser parses "key:arg1=value1;arg2=value2" into { arg1: value1, arg2: value2 }
 */
export declare function buildAgentButtonCustomId(componentId: string): string;
/**
 * Build agent select menu custom ID: agentsel:componentId=<id>
 */
export declare function buildAgentSelectCustomId(componentId: string): string;
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
export declare function createDiscordComponentButton(ctx: AgentComponentContext): Button;
export declare function createDiscordComponentStringSelect(ctx: AgentComponentContext): StringSelectMenu;
export declare function createDiscordComponentUserSelect(ctx: AgentComponentContext): UserSelectMenu;
export declare function createDiscordComponentRoleSelect(ctx: AgentComponentContext): RoleSelectMenu;
export declare function createDiscordComponentMentionableSelect(ctx: AgentComponentContext): MentionableSelectMenu;
export declare function createDiscordComponentChannelSelect(ctx: AgentComponentContext): ChannelSelectMenu;
export declare function createDiscordComponentModal(ctx: AgentComponentContext): Modal;
