import type { ChannelMessageActionAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  listPumbleAccountIds,
  resolveDefaultPumbleAccountId,
  resolvePumbleAccount,
} from "./accounts.js";
import { resolvePumbleActionsConfig } from "./config-accessors.js";
import { addPumbleReaction, removePumbleReaction } from "./reactions.js";

export const pumbleMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const hasReactionCapableAccount = listPumbleAccountIds(cfg)
      .map((accountId) => resolvePumbleAccount({ cfg, accountId }))
      .filter((account) => account.enabled)
      .filter((account) => Boolean(account.botToken?.trim() && account.appKey?.trim()))
      .some((account) => resolvePumbleActionsConfig(cfg, account.accountId).reactions);

    if (!hasReactionCapableAccount) {
      return [];
    }

    return ["react"];
  },
  supportsAction: ({ action }) => {
    return action === "react";
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action !== "react") {
      throw new Error(`Pumble action ${action} not supported`);
    }
    const resolvedAccountId = accountId ?? resolveDefaultPumbleAccountId(cfg);
    const actionsFlags = resolvePumbleActionsConfig(cfg, resolvedAccountId);
    if (!actionsFlags.reactions) {
      throw new Error("Pumble reactions are disabled in config");
    }

    const p = params as Record<string, unknown> | undefined;
    const messageIdRaw = typeof p?.messageId === "string" ? p.messageId : "";
    const messageId = messageIdRaw.trim();
    if (!messageId) {
      throw new Error("Pumble react requires messageId");
    }

    const emojiRaw = typeof p?.emoji === "string" ? p.emoji : "";
    const emojiName = emojiRaw.trim().replace(/^:+|:+$/g, "");
    if (!emojiName) {
      throw new Error("Pumble react requires emoji");
    }

    const remove = p?.remove === true;
    if (remove) {
      const result = await removePumbleReaction({
        cfg,
        messageId,
        emojiName,
        accountId: resolvedAccountId,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        content: [
          { type: "text" as const, text: `Removed reaction :${emojiName}: from ${messageId}` },
        ],
        details: {},
      };
    }

    const result = await addPumbleReaction({
      cfg,
      messageId,
      emojiName,
      accountId: resolvedAccountId,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    return {
      content: [{ type: "text" as const, text: `Reacted with :${emojiName}: on ${messageId}` }],
      details: {},
    };
  },
};
