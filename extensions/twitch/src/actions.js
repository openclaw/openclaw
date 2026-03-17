import { DEFAULT_ACCOUNT_ID, getAccountConfig } from "./config.js";
import { twitchOutbound } from "./outbound.js";
function errorResponse(error) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error })
      }
    ],
    details: { ok: false }
  };
}
function readStringParam(args, key, options = {}) {
  const value = args[key];
  if (value === void 0 || value === null) {
    if (options.required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return void 0;
  }
  if (typeof value === "string") {
    return options.trim !== false ? value.trim() : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const str = String(value);
    return options.trim !== false ? str.trim() : str;
  }
  throw new Error(`Parameter ${key} must be a string, number, or boolean`);
}
const TWITCH_ACTIONS = /* @__PURE__ */ new Set(["send"]);
const twitchMessageActions = {
  /**
   * List available actions for this channel.
   */
  listActions: () => [...TWITCH_ACTIONS],
  /**
   * Check if an action is supported.
   */
  supportsAction: ({ action }) => TWITCH_ACTIONS.has(action),
  /**
   * Extract tool send parameters from action arguments.
   *
   * Parses and validates the "to" and "message" parameters for sending.
   *
   * @param params - Arguments from the tool call
   * @returns Parsed send parameters or null if invalid
   *
   * @example
   * const result = twitchMessageActions.extractToolSend!({
   *   args: { to: "#mychannel", message: "Hello!" }
   * });
   * // Returns: { to: "#mychannel", message: "Hello!" }
   */
  extractToolSend: ({ args }) => {
    try {
      const to = readStringParam(args, "to", { required: true });
      const message = readStringParam(args, "message", { required: true });
      if (!to || !message) {
        return null;
      }
      return { to, message };
    } catch {
      return null;
    }
  },
  /**
   * Handle an action execution.
   *
   * Processes the "send" action to send messages to Twitch.
   *
   * @param ctx - Action context including action type, parameters, and config
   * @returns Tool result with content or null if action not supported
   *
   * @example
   * const result = await twitchMessageActions.handleAction!({
   *   action: "send",
   *   params: { message: "Hello Twitch!", to: "#mychannel" },
   *   cfg: openclawConfig,
   *   accountId: "default",
   * });
   */
  handleAction: async (ctx) => {
    if (ctx.action !== "send") {
      return {
        content: [{ type: "text", text: "Unsupported action" }],
        details: { ok: false, error: "Unsupported action" }
      };
    }
    const message = readStringParam(ctx.params, "message", { required: true });
    const to = readStringParam(ctx.params, "to", { required: false });
    const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
    const account = getAccountConfig(ctx.cfg, accountId);
    if (!account) {
      return errorResponse(
        `Account not found: ${accountId}. Available accounts: ${Object.keys(ctx.cfg.channels?.twitch?.accounts ?? {}).join(", ") || "none"}`
      );
    }
    const targetChannel = to || account.channel;
    if (!targetChannel) {
      return errorResponse("No channel specified and no default channel in account config");
    }
    if (!twitchOutbound.sendText) {
      return errorResponse("sendText not implemented");
    }
    try {
      const result = await twitchOutbound.sendText({
        cfg: ctx.cfg,
        to: targetChannel,
        text: message ?? "",
        accountId
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ],
        details: { ok: true }
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return errorResponse(errorMsg);
    }
  }
};
export {
  twitchMessageActions
};
