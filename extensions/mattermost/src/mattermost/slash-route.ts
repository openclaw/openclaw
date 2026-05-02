import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { MattermostConfig } from "../types.js";
import {
  parseSlashCommandPayload,
  resolveSlashCommandConfig,
  type MattermostSlashCommandConfig,
} from "./slash-commands.js";
import {
  getSlashCommandAccountStates,
  resolveSlashHandlerForCommand,
  resolveSlashHandlerForToken,
  type SlashHandlerMatch,
} from "./slash-shared-state.js";

const MULTI_ACCOUNT_BODY_MAX_BYTES = 64 * 1024;
const MULTI_ACCOUNT_BODY_TIMEOUT_MS = 5_000;

/**
 * Register the HTTP route for slash command callbacks.
 * Called during plugin registration.
 *
 * The single HTTP route dispatches to the correct per-account handler by
 * matching the inbound token against each account's known tokens, falling back
 * to registered team/trigger ownership so upstream validation can accept a
 * rotated Mattermost token.
 */
export function registerSlashCommandRoute(api: OpenClawPluginApi) {
  const mmConfig = api.config.channels?.mattermost as MattermostConfig | undefined;
  const accountStates = getSlashCommandAccountStates();

  // Collect callback paths from both top-level and per-account config.
  // Command registration uses account.config.commands, so the HTTP route
  // registration must include any account-specific callbackPath overrides.
  // Also extract the pathname from an explicit callbackUrl when it differs
  // from callbackPath, so that Mattermost callbacks hit a registered route.
  const callbackPaths = new Set<string>();

  const addCallbackPaths = (raw: Partial<MattermostSlashCommandConfig> | undefined) => {
    const resolved = resolveSlashCommandConfig(raw);
    callbackPaths.add(resolved.callbackPath);
    if (resolved.callbackUrl) {
      try {
        const urlPath = new URL(resolved.callbackUrl).pathname;
        if (urlPath && urlPath !== resolved.callbackPath) {
          callbackPaths.add(urlPath);
        }
      } catch {
        // Invalid URL — ignore, will be caught during registration
      }
    }
  };

  addCallbackPaths(mmConfig?.commands as Partial<MattermostSlashCommandConfig> | undefined);

  const accountsRaw = mmConfig?.accounts ?? {};
  for (const accountId of Object.keys(accountsRaw)) {
    addCallbackPaths(accountsRaw[accountId]?.commands);
  }

  const routeHandler = async (req: IncomingMessage, res: ServerResponse) => {
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

    // We need to peek at the body to route to the right account handler. Each
    // account handler still performs upstream token validation before running a
    // command.

    // If there's only one active account (common case), route directly.
    if (accountStates.size === 1) {
      const [, state] = [...accountStates.entries()][0];
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

    // Multi-account: buffer the body, find the matching account by token or
    // registered team/trigger, then replay the request to the correct handler.
    // Use the bounded helper so a slow/never-finishing client cannot tie up the
    // routing handler indefinitely (Slowloris).
    let bodyStr: string;
    try {
      bodyStr = await readRequestBodyWithLimit(req, {
        maxBytes: MULTI_ACCOUNT_BODY_MAX_BYTES,
        timeoutMs: MULTI_ACCOUNT_BODY_TIMEOUT_MS,
      });
    } catch (error) {
      if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.end("Request body timeout");
        return;
      }
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }

    // Parse the token for the fast path; if it misses, parse the full slash
    // payload so rotated tokens can still route by registered team/trigger.
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

    let match: SlashHandlerMatch = token ? resolveSlashHandlerForToken(token) : { kind: "none" };
    if (match.kind === "none") {
      const payload = parseSlashCommandPayload(bodyStr, ct);
      if (payload) {
        match = resolveSlashHandlerForCommand({
          teamId: payload.team_id,
          command: payload.command,
        });
      }
    }

    if (match.kind === "none") {
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

    if (match.kind === "ambiguous") {
      api.logger.warn?.(
        `mattermost: slash callback matched multiple accounts via ${match.source} (${match.accountIds.join(", ")})`,
      );
      const conflictText =
        match.source === "token"
          ? "Conflict: command token is not unique across accounts."
          : "Conflict: slash command is not unique across accounts.";
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text: conflictText,
        }),
      );
      return;
    }

    const matchedHandler = match.handler;

    // Replay: create a synthetic readable that re-emits the buffered body
    const syntheticReq = new Readable({
      read() {
        this.push(Buffer.from(bodyStr, "utf8"));
        this.push(null);
      },
    }) as IncomingMessage;

    syntheticReq.method = req.method;
    syntheticReq.url = req.url;
    syntheticReq.headers = req.headers;

    await matchedHandler(syntheticReq, res);
  };

  for (const callbackPath of callbackPaths) {
    api.registerHttpRoute({
      path: callbackPath,
      auth: "plugin",
      handler: routeHandler,
    });
  }
}
