// Discord plugin module implements native command dispatch behavior.
import type { ChatCommandDefinition, CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type {
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

type DispatchDiscordCommandInteractionParams = {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  preferFollowUp: boolean;
  threadBindings: ThreadBindingManager;
  responseEphemeral?: boolean;
  suppressReplies?: boolean;
  /** Fail closed if fresh route resolution no longer matches the initiating control. */
  expectedRoute?: Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;
  /** Require a fresh host-side core-command policy decision before dispatch. */
  requireCoreCommandAuthorization?: boolean;
  /** Canonical command effect bound to the final native authorization decision. */
  commandAuthorizationValues?: Record<string, string>;
};

export type DispatchDiscordCommandInteractionResult =
  | {
      accepted: true;
      effectiveRoute?: ResolvedAgentRoute;
      /** Positive proof required by native UI fallbacks before mutating session state. */
      coreCommandAuthorization?: {
        agentId: string;
        sessionKey: string;
        commandName: string;
        rawArguments?: string;
        values?: Readonly<Record<string, string>>;
      };
    }
  | {
      accepted: false;
      rejection?: "authorization-denied" | "route-mismatch";
    };

export type DispatchDiscordCommandInteraction = (
  params: DispatchDiscordCommandInteractionParams,
) => Promise<DispatchDiscordCommandInteractionResult>;
