import {
  findCommandByNativeName,
  type ChatCommandDefinition,
  type CommandArgDefinition,
  type CommandArgValues,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import type { CommandInteraction } from "../internal/discord.js";
import type { DiscordCommandArgs } from "./native-command.types.js";

export function readDiscordCommandArgs(
  interaction: CommandInteraction,
  definitions?: CommandArgDefinition[],
): DiscordCommandArgs | undefined {
  if (!definitions || definitions.length === 0) {
    return undefined;
  }
  const values: CommandArgValues = {};
  for (const definition of definitions) {
    let value: string | number | boolean | null | undefined;
    if (definition.type === "number") {
      value = interaction.options.getNumber(definition.name) ?? null;
    } else if (definition.type === "boolean") {
      value = interaction.options.getBoolean(definition.name) ?? null;
    } else {
      value = interaction.options.getString(definition.name) ?? null;
    }
    if (value != null) {
      values[definition.name] = value;
    }
  }
  return Object.keys(values).length > 0 ? { values } : undefined;
}

export function createNativeCommandDefinition(command: NativeCommandSpec): ChatCommandDefinition {
  const sharedCommand = findCommandByNativeName(command.name);
  return {
    key: sharedCommand?.key ?? command.name,
    nativeName: sharedCommand?.nativeName ?? command.name,
    description: sharedCommand?.description ?? command.description,
    descriptionLocalizations:
      sharedCommand?.descriptionLocalizations ?? command.descriptionLocalizations,
    textAliases: [],
    acceptsArgs: command.acceptsArgs,
    args: sharedCommand?.args ?? command.args,
    argsParsing: sharedCommand?.argsParsing ?? "none",
    formatArgs: sharedCommand?.formatArgs,
    scope: "native",
  };
}
