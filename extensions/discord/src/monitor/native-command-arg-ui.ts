import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
} from "discord-api-types/v10";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  listChatCommands,
  serializeCommandArgs,
  type ChatCommandDefinition,
  type CommandArgDefinition,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import { decodeCustomIdComponent, encodeCustomIdComponent } from "../custom-id-codec.js";
import type { BaseMessageInteractiveComponent, ComponentData } from "../internal/discord.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type {
  DiscordCommandArgContext,
  SafeDiscordInteractionCall,
} from "./native-command-ui.types.js";

const DISCORD_COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";

function parseDiscordCommandArgData(
  data: ComponentData,
): { command: string; arg: string; value: string; userId: string } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawCommand = coerce(data.command);
  const rawArg = coerce(data.arg);
  const rawValue = coerce(data.value);
  const rawUser = coerce(data.user);
  if (!rawCommand || !rawArg || !rawValue || !rawUser) {
    return null;
  }
  return {
    command: decodeCustomIdComponent(rawCommand),
    arg: decodeCustomIdComponent(rawArg),
    value: decodeCustomIdComponent(rawValue),
    userId: decodeCustomIdComponent(rawUser),
  };
}

type DiscordCommandArgButtonParams = {
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
};

export function buildDiscordCommandArgMenu(params: {
  command: ChatCommandDefinition;
  menu: {
    arg: CommandArgDefinition;
    choices: Array<{ value: string; label: string }>;
    title?: string;
  };
  userId: string;
}): { content: string; components: APIActionRowComponent<APIButtonComponent>[] } {
  const { command, menu, userId } = params;
  const commandLabel = command.nativeName ?? command.key;
  const rows = chunkItems(menu.choices, 4).map((choices) => {
    const buttons = choices.map((choice) => {
      const label = choice.label;
      const arg = menu.arg.name;
      const value = choice.value;
      return {
        type: ComponentType.Button as const,
        label,
        custom_id: [
          `${DISCORD_COMMAND_ARG_CUSTOM_ID_KEY}:command=${encodeCustomIdComponent(commandLabel)}`,
          `arg=${encodeCustomIdComponent(arg)}`,
          `value=${encodeCustomIdComponent(value)}`,
          `user=${encodeCustomIdComponent(userId)}`,
        ].join(";"),
        style: ButtonStyle.Secondary as const,
      };
    });
    return { type: ComponentType.ActionRow as const, components: buttons };
  });
  const content = formatCommandArgMenuTitle({ command, menu });
  return { content, components: rows };
}

export function createDiscordCommandArgFallbackButton(
  params: DiscordCommandArgButtonParams,
): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.Button,
    customId: "cmdarg:seed=1",
    async run(interaction, data) {
      const { ctx, safeInteractionCall, dispatchCommandInteraction } = params;
      const clearWithMessage = async (content: string) =>
        await safeInteractionCall("command arg update", () =>
          interaction.update({ content, components: [] }),
        );
      const parsed = parseDiscordCommandArgData(data);
      if (!parsed) {
        await clearWithMessage("Sorry, that selection is no longer available.");
        return;
      }
      if (interaction.user?.id && interaction.user.id !== parsed.userId) {
        await safeInteractionCall("command arg ack", () => interaction.acknowledge());
        return;
      }
      const commandDefinition =
        findCommandByNativeName(parsed.command, "discord") ??
        listChatCommands().find((entry) => entry.key === parsed.command);
      if (!commandDefinition) {
        await clearWithMessage("Sorry, that command is no longer available.");
        return;
      }
      const argUpdateResult = await clearWithMessage(`⏳ Applying ${parsed.value}...`);
      if (argUpdateResult === null) {
        return;
      }
      const commandArgs: CommandArgs = { values: { [parsed.arg]: parsed.value } };
      const commandArgsWithRaw: CommandArgs = {
        ...commandArgs,
        raw: serializeCommandArgs(commandDefinition, commandArgs),
      };
      const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
      await dispatchCommandInteraction({
        ...ctx,
        interaction,
        prompt,
        command: commandDefinition,
        commandArgs: commandArgsWithRaw,
        responseEphemeral: resolveDiscordSlashCommandConfig(ctx.discordConfig?.slashCommand)
          .ephemeral,
        pluginCommandDispatch: { kind: "non-plugin" },
      });
    },
  };
}
