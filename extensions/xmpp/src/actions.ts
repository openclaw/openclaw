import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk";
import {
  createActionGate,
  jsonResult,
  readStringParam,
  normalizeAccountId,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk";
import type { CoreConfig } from "./types.js";
import { XmppClient, isGroupJid, getBareJid } from "./client.js";

const providerId = "xmpp";

// Active XMPP clients keyed by accountId
// This should be imported from channel.ts, but for now we'll access via a shared registry
let clientsRegistry: Map<string, XmppClient> | null = null;

export function setXmppClientsRegistry(registry: Map<string, XmppClient>) {
  clientsRegistry = registry;
}

function normalizeXmppTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Remove xmpp: prefix if present
  const withoutXmpp = trimmed.replace(/^xmpp:/i, "").trim();
  return withoutXmpp;
}

export const xmppMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const xmppCfg = (cfg as CoreConfig).channels?.xmpp;
    if (!xmppCfg?.enabled || !xmppCfg?.jid || !xmppCfg?.password || !xmppCfg?.server) {
      return [];
    }

    const actions = new Set<ChannelMessageActionName>(["send"]);

    // XMPP supports reactions via XEP-0444
    const reactionsEnabled = createActionGate(xmppCfg.actions)("reactions");
    if (reactionsEnabled) {
      actions.add("react");
    }

    return Array.from(actions);
  },

  supportsAction: ({ action }) => action === "react",

  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (action === "react") {
      const xmppCfg = (cfg as CoreConfig).channels?.xmpp;

      // Check if reactions are enabled
      const actionsGate = createActionGate(xmppCfg?.actions);
      if (!actionsGate("reactions")) {
        throw new Error("XMPP reactions are disabled via actions.reactions.");
      }

      // Get client from registry
      if (!clientsRegistry) {
        throw new Error("XMPP client registry not initialized");
      }
      const normalizedAccountId = normalizeAccountId(accountId) || DEFAULT_ACCOUNT_ID;
      const client = clientsRegistry.get(normalizedAccountId);
      if (!client) {
        throw new Error(`XMPP client not connected for account "${normalizedAccountId}"`);
      }

      // Parse target
      const targetRaw = readStringParam(params, "to", {
        required: true,
        label: "target (JID)",
      });
      const target = normalizeXmppTarget(targetRaw);
      if (!target) {
        throw new Error("Invalid target JID");
      }

      // Get bare JID
      const bareJid = getBareJid(target);

      // Get message ID
      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId",
      });

      // Get emoji
      const emoji = readStringParam(params, "emoji", { required: true });

      // Check if remove
      const remove = typeof params.remove === "boolean" ? params.remove : false;

      // Determine message type
      const isRoom = isGroupJid(bareJid);
      const messageType = isRoom ? "groupchat" : "chat";

      if (remove) {
        // Send empty reactions array to remove
        await client.sendReaction(bareJid, messageId, [], messageType);
        return jsonResult({ ok: true, removed: emoji });
      }

      // Send reaction
      const emojis = Array.isArray(emoji) ? emoji : [emoji];
      await client.sendReaction(bareJid, messageId, emojis, messageType);
      return jsonResult({ ok: true, added: emojis.join(" ") });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
