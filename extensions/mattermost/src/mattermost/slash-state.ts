/**
 * Shared state for Mattermost slash commands.
 *
 * Bridges the plugin registration phase (HTTP route) with the monitor phase
 * (command registration with MM API). The HTTP handler needs to know which
 * tokens are valid, and the monitor needs to store registered command IDs.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedMattermostAccount } from "./accounts.js";
import { resolveSlashCommandConfig, type MattermostRegisteredCommand } from "./slash-commands.js";
import { createSlashCommandHttpHandler } from "./slash-http.js";

// ─── Shared mutable state ────────────────────────────────────────────────────

type SlashCommandState = {
  /** Tokens from registered commands, used for validation. */
  commandTokens: Set<string>;
  /** Registered command IDs for cleanup on shutdown. */
  registeredCommands: MattermostRegisteredCommand[];
  /** Current HTTP handler (set when an account activates). */
  handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null;
  /** The account that activated slash commands. */
  activeAccount: ResolvedMattermostAccount | null;
};

const state: SlashCommandState = {
  commandTokens: new Set(),
  registeredCommands: [],
  handler: null,
  activeAccount: null,
};

export function getSlashCommandState(): SlashCommandState {
  return state;
}

/**
 * Activate slash commands for a specific account.
 * Called from the monitor after bot connects.
 */
export function activateSlashCommands(params: {
  account: ResolvedMattermostAccount;
  commandTokens: string[];
  registeredCommands: MattermostRegisteredCommand[];
  api: {
    cfg: import("openclaw/plugin-sdk").OpenClawConfig;
    runtime: import("openclaw/plugin-sdk").RuntimeEnv;
  };
  log?: (msg: string) => void;
}) {
  const { account, commandTokens, registeredCommands, api, log } = params;

  state.commandTokens = new Set(commandTokens);
  state.registeredCommands = registeredCommands;
  state.activeAccount = account;

  state.handler = createSlashCommandHttpHandler({
    account,
    cfg: api.cfg,
    runtime: api.runtime,
    commandTokens: state.commandTokens,
    log,
  });

  log?.(`mattermost: slash commands activated (${registeredCommands.length} commands)`);
}

/**
 * Deactivate slash commands (on shutdown/disconnect).
 */
export function deactivateSlashCommands() {
  state.commandTokens.clear();
  state.registeredCommands = [];
  state.handler = null;
  state.activeAccount = null;
}

/**
 * Register the HTTP route for slash command callbacks.
 * Called during plugin registration.
 */
export function registerSlashCommandRoute(api: OpenClawPluginApi) {
  const mmConfig = api.config.channels?.mattermost as Record<string, unknown> | undefined;
  const commandsRaw = mmConfig?.commands as
    | Partial<import("./slash-commands.js").MattermostSlashCommandConfig>
    | undefined;
  const slashConfig = resolveSlashCommandConfig(commandsRaw);
  const callbackPath = slashConfig.callbackPath;

  api.registerHttpRoute({
    path: callbackPath,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!state.handler) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            response_type: "ephemeral",
            text: "Slash commands are not yet initialized. Please try again in a moment.",
          }),
        );
        return;
      }
      await state.handler(req, res);
    },
  });

  api.logger.info?.(`mattermost: registered slash command callback at ${callbackPath}`);
}
