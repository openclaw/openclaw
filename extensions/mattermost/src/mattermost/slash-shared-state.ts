import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  normalizeSlashCommandTrigger,
  type MattermostRegisteredCommand,
} from "./slash-commands.js";

type SlashHandlerMatchSource = "token" | "command";

export type SlashHandlerMatch =
  | { kind: "none" }
  | {
      kind: "single";
      source: SlashHandlerMatchSource;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
      accountIds: string[];
    }
  | {
      kind: "ambiguous";
      source: SlashHandlerMatchSource;
      accountIds: string[];
    };

export type SlashCommandAccountState = {
  /** Tokens from registered/current commands, used for fast-path routing. */
  commandTokens: Set<string>;
  /** Registered command IDs for cleanup on shutdown. */
  registeredCommands: MattermostRegisteredCommand[];
  /** Current HTTP handler for this account. */
  handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null;
  /** The account that activated slash commands. */
  account: ResolvedMattermostAccount;
  /** Map from trigger to original command name (for skill commands that start with oc_). */
  triggerMap: Map<string, string>;
};

const MATTERMOST_SLASH_STATE_KEY = Symbol.for("openclaw.mattermost.slashCommandState");

type MattermostSlashCommandSharedState = {
  accountStates: Map<string, SlashCommandAccountState>;
};

// The slash route can load through the bundled-entry jiti path while the
// monitor imports this state through native ESM. Keep the live state on a
// process-global symbol so both loaders share one Map.
function getMattermostSlashCommandSharedState(): MattermostSlashCommandSharedState {
  const globalState = globalThis as typeof globalThis & {
    [MATTERMOST_SLASH_STATE_KEY]?: MattermostSlashCommandSharedState;
  };
  if (!globalState[MATTERMOST_SLASH_STATE_KEY]) {
    globalState[MATTERMOST_SLASH_STATE_KEY] = {
      accountStates: new Map<string, SlashCommandAccountState>(),
    };
  }
  return globalState[MATTERMOST_SLASH_STATE_KEY];
}

export function getSlashCommandAccountStates(): Map<string, SlashCommandAccountState> {
  return getMattermostSlashCommandSharedState().accountStates;
}

export function resolveSlashHandlerForToken(token: string): SlashHandlerMatch {
  const matches: Array<{
    accountId: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }> = [];

  for (const [accountId, state] of getSlashCommandAccountStates()) {
    if (state.commandTokens.has(token) && state.handler) {
      matches.push({ accountId, handler: state.handler });
    }
  }

  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length === 1) {
    return {
      kind: "single",
      source: "token",
      handler: matches[0].handler,
      accountIds: [matches[0].accountId],
    };
  }

  return {
    kind: "ambiguous",
    source: "token",
    accountIds: matches.map((entry) => entry.accountId),
  };
}

export function resolveSlashHandlerForCommand(params: {
  teamId: string;
  command: string;
}): SlashHandlerMatch {
  const trigger = normalizeSlashCommandTrigger(params.command);
  if (!trigger) {
    return { kind: "none" };
  }

  const matches: Array<{
    accountId: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }> = [];

  for (const [accountId, state] of getSlashCommandAccountStates()) {
    if (
      state.handler &&
      state.registeredCommands.some(
        (cmd) => cmd.teamId === params.teamId && cmd.trigger === trigger,
      )
    ) {
      matches.push({ accountId, handler: state.handler });
    }
  }

  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length === 1) {
    return {
      kind: "single",
      source: "command",
      handler: matches[0].handler,
      accountIds: [matches[0].accountId],
    };
  }

  return {
    kind: "ambiguous",
    source: "command",
    accountIds: matches.map((entry) => entry.accountId),
  };
}

export function getSlashCommandState(accountId: string): SlashCommandAccountState | null {
  return getSlashCommandAccountStates().get(accountId) ?? null;
}
