import { type ChatCommandDefinition, type CommandArgDefinition, type NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import type { CommandInteraction } from "../internal/discord.js";
import type { DiscordCommandArgs } from "./native-command.types.js";
export declare function readDiscordCommandArgs(interaction: CommandInteraction, definitions?: CommandArgDefinition[]): DiscordCommandArgs | undefined;
export declare function createNativeCommandDefinition(command: NativeCommandSpec): ChatCommandDefinition;
