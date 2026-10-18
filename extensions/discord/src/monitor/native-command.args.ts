import type {
  ChatCommandDefinition,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
  NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import type { CommandInteraction } from "../internal/discord.js";

export function readDiscordCommandArgs(
  interaction: CommandInteraction,
  definitions?: CommandArgDefinition[],
): CommandArgs | undefined {
  if (!definitions || definitions.length === 0) {
    return undefined;
  }
  const values: CommandArgValues = {};
  for (const definition of definitions) {
    const getter =
      definition.type === "number"
        ? "getNumber"
        : definition.type === "boolean"
          ? "getBoolean"
          : "getString";
    const value = interaction.options[getter](definition.name);
    if (value != null) {
      values[definition.name] = value;
    }
  }
  return Object.keys(values).length > 0 ? { values } : undefined;
}

export function createNativeCommandDefinition(command: NativeCommandSpec): ChatCommandDefinition {
  return {
    key: command.name,
    nativeName: command.name,
    description: command.description,
    textAliases: [],
    acceptsArgs: command.acceptsArgs,
    args: command.args,
    argsParsing: "none",
    scope: "native",
  };
}
