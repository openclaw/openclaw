import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { AutocompleteInteraction, CommandInteraction } from "./interactions.js";
import { stripUndefinedFields as clean } from "./undefined-fields.js";

type CommandOption = Record<string, unknown> & {
  name: string;
  description?: string;
  type: ApplicationCommandOptionType;
  required?: boolean;
  choices?: Array<{ name: string; value: string | number | boolean }>;
  autocomplete?: boolean | ((interaction: AutocompleteInteraction) => Promise<void>);
};
export type CommandOptions = CommandOption[];
export type DiscordCommand = Command | CommandWithSubcommands;

type RawSubcommandOption = {
  name?: unknown;
  type?: unknown;
  options?: RawSubcommandOption[];
};

export async function deferCommandInteractionIfNeeded(
  command: BaseCommand,
  interaction: CommandInteraction,
): Promise<void> {
  if (!command.defer) {
    return;
  }
  await interaction.defer({
    ephemeral: command.ephemeral,
  });
}

function readRawCommandOptions(interaction: CommandInteraction): RawSubcommandOption[] {
  const options = (interaction.rawData as { data?: { options?: unknown } }).data?.options;
  return Array.isArray(options) ? (options as RawSubcommandOption[]) : [];
}

function findSelectedSubcommand(
  subcommands: Command[],
  interaction: CommandInteraction,
): Command | undefined {
  const subcommandName = readRawCommandOptions(interaction).find(
    (option) => option.type === ApplicationCommandOptionType.Subcommand,
  )?.name;
  return typeof subcommandName === "string"
    ? subcommands.find((command) => command.name === subcommandName)
    : undefined;
}

export function resolveFocusedCommandOptionAutocompleteHandler(
  command: DiscordCommand,
  interaction: AutocompleteInteraction,
): ((interaction: AutocompleteInteraction) => Promise<void>) | undefined {
  const focusedName = interaction.options.getFocused()?.name;
  const options =
    command.commandKind === "group"
      ? findSelectedSubcommand(command.subcommands, interaction)?.options
      : command.options;
  const autocomplete = focusedName
    ? options?.find((option) => option.name === focusedName)?.autocomplete
    : undefined;
  return typeof autocomplete === "function" ? autocomplete : undefined;
}

export abstract class BaseCommand {
  abstract readonly commandKind: "leaf" | "group";
  id?: string;
  abstract name: string;
  description?: string;
  descriptionLocalizations?: Record<string, string>;
  defer = false;
  ephemeral = false;
  abstract type: ApplicationCommandType;
  abstract serializeOptions(): unknown[] | undefined;
  serialize(): RESTPostAPIApplicationCommandsJSONBody {
    return clean({
      name: this.name,
      description:
        this.type === ApplicationCommandType.ChatInput ? (this.description ?? "") : undefined,
      description_localizations: this.descriptionLocalizations,
      type: this.type,
      options: this.serializeOptions() as RESTPostAPIApplicationCommandsJSONBody["options"],
      integration_types: [0, 1],
      contexts: [
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      ],
      default_member_permissions: null,
    }) as RESTPostAPIApplicationCommandsJSONBody;
  }
}

export abstract class Command extends BaseCommand {
  readonly commandKind = "leaf";
  options?: CommandOptions;
  type = ApplicationCommandType.ChatInput;
  abstract run(interaction: unknown): unknown;
  async autocomplete(interaction: unknown): Promise<void> {
    throw new Error(
      `The ${(interaction as { rawData?: { data?: { name?: string } } }).rawData?.data?.name ?? this.name} command does not support autocomplete`,
    );
  }
  serializeOptions() {
    return this.options?.map((option) => {
      if (typeof option.autocomplete === "function") {
        const { autocomplete: _autocomplete, ...rest } = option;
        return { ...rest, autocomplete: true };
      }
      return option;
    });
  }
}

export abstract class CommandWithSubcommands extends BaseCommand {
  readonly commandKind = "group";
  type = ApplicationCommandType.ChatInput;
  abstract subcommands: Command[];
  async run(interaction: CommandInteraction): Promise<unknown> {
    const subcommand = findSelectedSubcommand(this.subcommands, interaction);
    if (!subcommand) {
      const subcommandName = readRawCommandOptions(interaction).find(
        (option) => option.type === ApplicationCommandOptionType.Subcommand,
      )?.name;
      throw new Error(
        `Unknown Discord subcommand: ${typeof subcommandName === "string" ? subcommandName : "<missing>"}`,
      );
    }
    await deferCommandInteractionIfNeeded(subcommand, interaction);
    return await subcommand.run(interaction);
  }
  serializeOptions() {
    return this.subcommands.map((command) =>
      clean({
        name: command.name,
        description: command.description ?? "",
        description_localizations: command.descriptionLocalizations,
        type: ApplicationCommandOptionType.Subcommand,
        options: command.serializeOptions(),
      }),
    );
  }
}
