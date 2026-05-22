import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type ChatCommandDefinition } from "openclaw/plugin-sdk/native-command-registry";
import type { AutocompleteInteraction, CommandOptions } from "../internal/discord.js";
export declare function truncateDiscordCommandDescription(params: {
    value: string;
    label: string;
}): string;
export declare function truncateDiscordCommandDescriptionLocalizations(params: {
    value?: Record<string, string>;
    label: string;
}): Record<string, string> | undefined;
export declare function buildDiscordCommandOptions(params: {
    command: ChatCommandDefinition;
    cfg: OpenClawConfig;
    authorizeChoiceContext?: (interaction: AutocompleteInteraction) => Promise<boolean>;
    resolveChoiceContext?: (interaction: AutocompleteInteraction) => Promise<{
        provider?: string;
        model?: string;
    } | null>;
}): CommandOptions | undefined;
