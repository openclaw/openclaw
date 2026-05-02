/**
 * Shared state for Mattermost slash commands.
 *
 * Bridges the plugin registration phase (HTTP route) with the monitor phase
 * (command registration with MM API). The HTTP handler needs to know which
 * tokens are known for fast-path routing, and the monitor needs to store
 * registered command IDs.
 *
 * State is kept per-account so that multi-account deployments don't
 * overwrite each other's tokens, registered commands, or handlers.
 */

import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";
import {
  clearMattermostSlashCommandValidationCacheForAccount,
  createSlashCommandHttpHandler,
} from "./slash-http.js";
import {
  getSlashCommandAccountStates,
  getSlashCommandState,
  resolveSlashHandlerForCommand,
  resolveSlashHandlerForToken,
  type SlashCommandAccountState,
} from "./slash-shared-state.js";

export {
  getSlashCommandState,
  resolveSlashHandlerForCommand,
  resolveSlashHandlerForToken,
  type SlashCommandAccountState,
} from "./slash-shared-state.js";

/** Map from accountId → per-account slash command state. */
const accountStates = getSlashCommandAccountStates();

/**
 * Activate slash commands for a specific account.
 * Called from the monitor after bot connects.
 */
export function activateSlashCommands(params: {
  account: ResolvedMattermostAccount;
  commandTokens: string[];
  registeredCommands: MattermostRegisteredCommand[];
  triggerMap?: Map<string, string>;
  api: {
    cfg: import("./runtime-api.js").OpenClawConfig;
    runtime: import("./runtime-api.js").RuntimeEnv;
  };
  log?: (msg: string) => void;
}) {
  const { account, commandTokens, registeredCommands, triggerMap, api, log } = params;
  const accountId = account.accountId;

  const tokenSet = new Set(commandTokens);

  const handler = createSlashCommandHttpHandler({
    account,
    cfg: api.cfg,
    runtime: api.runtime,
    registeredCommands,
    triggerMap,
    log,
  });

  accountStates.set(accountId, {
    commandTokens: tokenSet,
    registeredCommands,
    handler,
    account,
    triggerMap: triggerMap ?? new Map(),
  });

  log?.(
    `mattermost: slash commands activated for account ${accountId} (${registeredCommands.length} commands)`,
  );
}

/**
 * Deactivate slash commands for a specific account (on shutdown/disconnect).
 */
export function deactivateSlashCommands(accountId?: string) {
  if (accountId) {
    const state = accountStates.get(accountId);
    if (state) {
      state.commandTokens.clear();
      state.registeredCommands = [];
      state.handler = null;
      clearMattermostSlashCommandValidationCacheForAccount(accountId);
      accountStates.delete(accountId);
    }
  } else {
    // Deactivate all accounts (full shutdown)
    for (const [stateAccountId, state] of accountStates) {
      state.commandTokens.clear();
      state.registeredCommands = [];
      state.handler = null;
      clearMattermostSlashCommandValidationCacheForAccount(stateAccountId);
    }
    accountStates.clear();
  }
}
