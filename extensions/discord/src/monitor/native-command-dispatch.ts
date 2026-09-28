import type { ChatCommandDefinition, CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import type { PluginCommandCatalogDecision } from "openclaw/plugin-sdk/plugin-command-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type {
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import type { DiscordCommandArgContext } from "./native-command-ui.types.js";

export type DispatchDiscordCommandInteractionParams = DiscordCommandArgContext & {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
  preferFollowUp: boolean;
  responseEphemeral?: boolean;
  suppressReplies?: boolean;
  pluginCommandDispatch: PluginCommandCatalogDecision;
};

export type DispatchDiscordCommandInteractionResult = {
  accepted: boolean;
  effectiveRoute?: ResolvedAgentRoute;
  hiddenFinalReply?: ReplyPayload;
};

export type DispatchDiscordCommandInteraction = (
  params: DispatchDiscordCommandInteractionParams,
) => Promise<DispatchDiscordCommandInteractionResult>;
