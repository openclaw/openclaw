import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { CommandWithSubcommands, type Command } from "../internal/discord.js";
import {
  truncateDiscordCommandDescription,
  truncateDiscordCommandDescriptionLocalizations,
} from "./native-command.options.js";

export type DiscordGoalAction = {
  name: string;
  description: string;
  field?: "objective" | "note";
  required?: boolean;
};

export function createDiscordGoalCommand(params: {
  command: NativeCommandSpec;
  ephemeralDefault: boolean;
  createSubcommand: (action: DiscordGoalAction) => Command;
}): CommandWithSubcommands {
  // Only the Discord form lives here; shared Goal parsing and lifecycle remain authoritative.
  const actions: DiscordGoalAction[] = [
    { name: "status", description: "Show the current goal." },
    {
      name: "start",
      description: "Start pursuing a new goal.",
      field: "objective",
      required: true,
    },
    {
      name: "edit",
      description: "Change the current goal's objective.",
      field: "objective",
      required: true,
    },
    { name: "pause", description: "Pause the current goal.", field: "note" },
    { name: "resume", description: "Resume pursuing the current goal.", field: "note" },
    { name: "complete", description: "Mark the current goal complete.", field: "note" },
    { name: "block", description: "Mark the current goal blocked.", field: "note" },
    { name: "clear", description: "Remove the current goal." },
  ];
  return new (class extends CommandWithSubcommands {
    override name = params.command.name;
    override description = truncateDiscordCommandDescription({ value: params.command.description });
    override descriptionLocalizations = truncateDiscordCommandDescriptionLocalizations({
      value: params.command.descriptionLocalizations,
    });
    override ephemeral = params.ephemeralDefault;
    override subcommands = actions.map((action) => {
      const command = params.createSubcommand(action);
      command.name = action.name;
      command.description = action.description;
      command.descriptionLocalizations = undefined;
      command.options = action.field
        ? [
            {
              name: action.field,
              description:
                action.field === "objective"
                  ? "What should the agent accomplish?"
                  : "Reason or context for this action",
              type: ApplicationCommandOptionType.String,
              required: action.required ?? false,
            },
          ]
        : [];
      return command;
    });
  })();
}
