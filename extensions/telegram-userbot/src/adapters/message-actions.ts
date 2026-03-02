/**
 * Message actions adapter for the telegram-userbot channel.
 *
 * Maps OpenClaw action names (delete, edit, react, pin, unsend) to
 * UserbotClient methods on the active ConnectionManager instance.
 */

import {
  createActionGate,
  extractToolSend,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionName,
} from "openclaw/plugin-sdk";
import { getConnectionManager } from "../channel.js";
import { TELEGRAM_USERBOT_CHANNEL_ID } from "../config-schema.js";
import { resolveTelegramUserbotAccount } from "./config.js";

// ---------------------------------------------------------------------------
// Supported actions
// ---------------------------------------------------------------------------

const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>([
  "delete",
  "edit",
  "react",
  "pin",
  "unsend",
]);

type ActionGateKey = "messages" | "reactions" | "pins";

/**
 * Map each supported action to its gate key in the config
 * (channels.telegram-userbot.actions).
 */
const ACTION_GATE: Record<string, ActionGateKey> = {
  delete: "messages",
  edit: "messages",
  unsend: "messages",
  react: "reactions",
  pin: "pins",
};

const PROVIDER_ID = "telegram-userbot";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the peer target from action params or toolContext.
 * Telegram userbot targets are numeric chat IDs or @usernames.
 */
function resolvePeerTarget(
  params: Record<string, unknown>,
  toolContext?: { currentChannelId?: string },
): string {
  const to =
    readStringParam(params, "to") ??
    readStringParam(params, "chatId") ??
    readStringParam(params, "peer");
  if (to) return to;

  // Fall back to the current channel from toolContext
  const contextTarget = toolContext?.currentChannelId?.trim();
  if (contextTarget) {
    // Strip channel prefix if present (e.g., "telegram-userbot:12345" -> "12345")
    return contextTarget.replace(/^telegram-userbot:/i, "");
  }

  throw new Error(`${PROVIDER_ID} action requires a target (to, chatId, or peer parameter).`);
}

/**
 * Get the active UserbotClient for an account, throwing if unavailable.
 */
function requireClient(accountId?: string | null) {
  const id = accountId?.trim() || "default";
  const manager = getConnectionManager(id);
  if (!manager) {
    throw new Error(
      `${PROVIDER_ID}: no active connection for account "${id}". Is the gateway running?`,
    );
  }
  const client = manager.getClient();
  if (!client) {
    throw new Error(`${PROVIDER_ID}: client is not connected for account "${id}".`);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const telegramUserbotMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const account = resolveTelegramUserbotAccount({ cfg });
    if (!account.enabled || !account.configured) {
      return [];
    }
    const gate = createActionGate(
      (cfg.channels?.[TELEGRAM_USERBOT_CHANNEL_ID] as Record<string, unknown> | undefined)
        ?.actions as Record<string, boolean | undefined> | undefined,
    );
    const actions: ChannelMessageActionName[] = [];
    for (const action of SUPPORTED_ACTIONS) {
      const gateKey = ACTION_GATE[action];
      if (gateKey && gate(gateKey)) {
        actions.push(action);
      }
    }
    return actions;
  },

  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),

  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),

  handleAction: async (ctx) => {
    const { action, params, accountId, toolContext } = ctx;
    const client = requireClient(accountId);

    // -- delete / unsend -------------------------------------------------------
    if (action === "delete" || action === "unsend") {
      const peer = resolvePeerTarget(params, toolContext);
      const messageId = readNumberParam(params, "messageId", {
        required: true,
        integer: true,
        label: "messageId",
      });
      // Revoke for both parties (true)
      await client.deleteMessages(peer, [messageId!], true);
      return jsonResult({ ok: true, deleted: messageId });
    }

    // -- edit ------------------------------------------------------------------
    if (action === "edit") {
      const peer = resolvePeerTarget(params, toolContext);
      const messageId = readNumberParam(params, "messageId", {
        required: true,
        integer: true,
        label: "messageId",
      });
      const text =
        readStringParam(params, "text") ??
        readStringParam(params, "newText") ??
        readStringParam(params, "message");
      if (!text) {
        throw new Error(`${PROVIDER_ID} edit requires text (or newText/message) parameter.`);
      }
      await client.editMessage(peer, messageId!, text);
      return jsonResult({ ok: true, edited: messageId });
    }

    // -- react -----------------------------------------------------------------
    if (action === "react") {
      const peer = resolvePeerTarget(params, toolContext);
      const messageId = readNumberParam(params, "messageId", {
        required: true,
        integer: true,
        label: "messageId",
      });
      const { emoji, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to react to a Telegram message.",
      });
      if (isEmpty) {
        throw new Error(
          `${PROVIDER_ID} react requires emoji parameter. ` +
            `Use action=react with emoji=<emoji> and messageId=<id>.`,
        );
      }
      await client.reactToMessage(peer, messageId!, emoji);
      return jsonResult({ ok: true, reacted: emoji, messageId });
    }

    // -- pin -------------------------------------------------------------------
    if (action === "pin") {
      const peer = resolvePeerTarget(params, toolContext);
      const messageId = readNumberParam(params, "messageId", {
        required: true,
        integer: true,
        label: "messageId",
      });
      await client.pinMessage(peer, messageId!);
      return jsonResult({ ok: true, pinned: messageId });
    }

    // -- fallback: unsupported -------------------------------------------------
    throw new Error(`Action "${action}" is not supported for provider ${PROVIDER_ID}.`);
  },
};
