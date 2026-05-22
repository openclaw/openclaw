import { type ChatCommandDefinition, type CommandArgDefinition } from "openclaw/plugin-sdk/command-auth-native";
import { Button, Row, type ButtonInteraction, type CommandInteraction, type ComponentData } from "../internal/discord.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type { DiscordCommandArgContext, SafeDiscordInteractionCall } from "./native-command-ui.types.js";
export declare function buildDiscordCommandArgCustomId(params: {
    command: string;
    arg: string;
    value: string;
    userId: string;
}): string;
export declare function handleDiscordCommandArgInteraction(params: {
    interaction: ButtonInteraction;
    data: ComponentData;
    ctx: DiscordCommandArgContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}): Promise<void>;
type DiscordCommandArgButtonParams = {
    ctx: DiscordCommandArgContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
};
export declare function buildDiscordCommandArgMenu(params: {
    command: ChatCommandDefinition;
    menu: {
        arg: CommandArgDefinition;
        choices: Array<{
            value: string;
            label: string;
        }>;
        title?: string;
    };
    interaction: CommandInteraction;
    ctx: DiscordCommandArgContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}): {
    content: string;
    components: Row<Button>[];
};
export declare function createDiscordCommandArgFallbackButton(params: DiscordCommandArgButtonParams): Button;
export {};
