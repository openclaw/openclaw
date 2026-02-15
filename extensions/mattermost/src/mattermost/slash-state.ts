/**
 * Shared state for Mattermost slash commands.
 *
 * Bridges the plugin registration phase (HTTP route) with the monitor phase
 * (command registration with MM API). The HTTP handler needs to know which
 * tokens are valid, and the monitor needs to store registered command IDs.
 *
 * State is kept per-account so that multi-account deployments don't
 * overwrite each other's tokens, registered commands, or handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedMattermostAccount } from "./accounts.js";
import { resolveSlashCommandConfig, type MattermostRegisteredCommand } from "./slash-commands.js";
import { createSlashCommandHttpHandler } from "./slash-http.js";

// ─── Per-account state ───────────────────────────────────────────────────────

type SlashCommandAccountState = {
  /** Tokens from registered commands, used for validation. */
  commandTokens: Set<string>;
  /** Registered command IDs for cleanup on shutdown. */
  registeredCommands: MattermostRegisteredCommand[];
  /** Current HTTP handler for this account. */
  handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null;
  /** The account that activated slash commands. */
  account: ResolvedMattermostAccount;
};

/** Map from accountId → per-account slash command state. */
const accountStates = new Map<string, SlashCommandAccountState>();

/**
 * Get the slash command state for a specific account, or null if not activated.
 */
export function getSlashCommandState(accountId: string): SlashCommandAccountState | null {
  return accountStates.get(accountId) ?? null;
}

/**
 * Get all active slash command account states.
 */
export function getAllSlashCommandStates(): ReadonlyMap<string, SlashCommandAccountState> {
  return accountStates;
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
  const accountId = account.accountId;

  const tokenSet = new Set(commandTokens);

  const handler = createSlashCommandHttpHandler({
    account,
    cfg: api.cfg,
    runtime: api.runtime,
    commandTokens: tokenSet,
    log,
  });

  accountStates.set(accountId, {
    commandTokens: tokenSet,
    registeredCommands,
    handler,
    account,
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
      accountStates.delete(accountId);
    }
  } else {
    // Deactivate all accounts (full shutdown)
    for (const [, state] of accountStates) {
      state.commandTokens.clear();
      state.registeredCommands = [];
      state.handler = null;
    }
    accountStates.clear();
  }
}

/**
 * Register the HTTP route for slash command callbacks.
 * Called during plugin registration.
 *
 * The single HTTP route dispatches to the correct per-account handler
 * by matching the inbound token against each account's registered tokens.
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
      if (accountStates.size === 0) {
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

      // We need to peek at the token to route to the right account handler.
      // Since each account handler also validates the token, we find the
      // account whose token set contains the inbound token and delegate.
      // If none match, we pick the first handler and let its own validation
      // reject the request (fail closed).

      // For multi-account routing: the handlers read the body themselves,
      // so we can't pre-parse here without buffering. Instead, if there's
      // only one active account (common case), route directly.
      if (accountStates.size === 1) {
        const [, state] = [...accountStates.entries()][0]!;
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
        return;
      }

      // Multi-account: buffer the body, find the matching account by token,
      // then replay the request to the correct handler.
      const chunks: Buffer[] = [];
      const MAX_BODY = 64 * 1024;
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          res.statusCode = 413;
          res.end("Payload Too Large");
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const bodyStr = Buffer.concat(chunks).toString("utf8");

      // Parse just the token to find the right account
      let token: string | null = null;
      const ct = req.headers["content-type"] ?? "";
      try {
        if (ct.includes("application/json")) {
          token = (JSON.parse(bodyStr) as { token?: string }).token ?? null;
        } else {
          token = new URLSearchParams(bodyStr).get("token");
        }
      } catch {
        // parse failed — will be caught by handler
      }

      // Find the account whose tokens include this one
      let matchedHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null =
        null;

      if (token) {
        for (const [, state] of accountStates) {
          if (state.commandTokens.has(token) && state.handler) {
            matchedHandler = state.handler;
            break;
          }
        }
      }

      if (!matchedHandler) {
        // No matching account — reject
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            response_type: "ephemeral",
            text: "Unauthorized: invalid command token.",
          }),
        );
        return;
      }

      // Replay: create a synthetic readable that re-emits the buffered body
      const { Readable } = await import("node:stream");
      const syntheticReq = new Readable({
        read() {
          this.push(Buffer.from(bodyStr, "utf8"));
          this.push(null);
        },
      }) as IncomingMessage;

      // Copy necessary IncomingMessage properties
      syntheticReq.method = req.method;
      syntheticReq.url = req.url;
      syntheticReq.headers = req.headers;

      await matchedHandler(syntheticReq, res);
    },
  });

  api.logger.info?.(`mattermost: registered slash command callback at ${callbackPath}`);
}
