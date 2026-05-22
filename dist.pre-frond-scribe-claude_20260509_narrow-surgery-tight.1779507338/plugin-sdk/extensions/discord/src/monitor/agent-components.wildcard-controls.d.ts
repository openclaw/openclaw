import { BaseMessageInteractiveComponent, Button, type ButtonInteraction, type ComponentData } from "../internal/discord.js";
import { type AgentComponentContext, type AgentComponentMessageInteraction } from "./agent-components-helpers.js";
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
    }) => Promise<void>;
};
export declare function createDiscordComponentButtonControl(ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers): Button;
export declare const createDiscordComponentStringSelectControl: (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) => BaseMessageInteractiveComponent;
export declare const createDiscordComponentUserSelectControl: (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) => BaseMessageInteractiveComponent;
export declare const createDiscordComponentRoleSelectControl: (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) => BaseMessageInteractiveComponent;
export declare const createDiscordComponentMentionableSelectControl: (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) => BaseMessageInteractiveComponent;
export declare const createDiscordComponentChannelSelectControl: (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) => BaseMessageInteractiveComponent;
