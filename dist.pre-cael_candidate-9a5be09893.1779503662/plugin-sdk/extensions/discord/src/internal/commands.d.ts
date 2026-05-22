import { ApplicationCommandOptionType, ApplicationCommandType, InteractionContextType, type RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import type { BaseMessageInteractiveComponent } from "./components.js";
import type { AutocompleteInteraction, CommandInteraction } from "./interactions.js";
export type ConditionalCommandOption = (interaction: unknown) => boolean;
export type CommandOption = Record<string, unknown> & {
    name: string;
    description?: string;
    type: ApplicationCommandOptionType;
    required?: boolean;
    choices?: Array<{
        name: string;
        value: string | number | boolean;
    }>;
    autocomplete?: boolean | ((interaction: AutocompleteInteraction) => Promise<void>);
};
export type CommandOptions = CommandOption[];
export declare function deferCommandInteractionIfNeeded(command: BaseCommand, interaction: CommandInteraction): Promise<void>;
export declare function resolveFocusedCommandOptionAutocompleteHandler(command: BaseCommand, interaction: AutocompleteInteraction): ((interaction: AutocompleteInteraction) => Promise<void>) | undefined;
export declare abstract class BaseCommand {
    id?: string;
    abstract name: string;
    description?: string;
    nameLocalizations?: Record<string, string>;
    descriptionLocalizations?: Record<string, string>;
    defer: boolean | ConditionalCommandOption;
    ephemeral: boolean | ConditionalCommandOption;
    abstract type: ApplicationCommandType;
    integrationTypes: number[];
    contexts: InteractionContextType[];
    permission?: bigint | bigint[];
    components?: BaseMessageInteractiveComponent[];
    guildIds?: string[];
    abstract serializeOptions(): unknown[] | undefined;
    serialize(): RESTPostAPIApplicationCommandsJSONBody;
}
export declare abstract class Command extends BaseCommand {
    options?: CommandOptions;
    type: ApplicationCommandType;
    abstract run(interaction: unknown): unknown;
    autocomplete(interaction: unknown): Promise<void>;
    preCheck(interaction: unknown): Promise<unknown>;
    serializeOptions(): unknown[];
}
export declare abstract class CommandWithSubcommands extends BaseCommand {
    type: ApplicationCommandType;
    abstract subcommands: Command[];
    run(interaction: CommandInteraction): Promise<unknown>;
    serializeOptions(): {
        name: string;
        name_localizations: Record<string, string> | undefined;
        description: string;
        description_localizations: Record<string, string> | undefined;
        type: ApplicationCommandOptionType;
        options: unknown[];
    }[];
}
