import {
  createActionGate,
  jsonResult,
  readStringParam,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listEnabledSignalAccounts, resolveSignalAccount } from "./accounts.js";
import { normalizeSignalReactionRecipient } from "./normalize.js";
import { resolveSignalReactionLevel } from "./reaction-level.js";
import { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";

const providerId = "signal";
const GROUP_PREFIX = "group:";

export const signalMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const configuredAccounts = accountId
      ? [resolveSignalAccount({ cfg, accountId })].filter(
          (account) => account.enabled && account.configured,
        )
      : listEnabledSignalAccounts(cfg).filter((account) => account.configured);
    if (configuredAccounts.length === 0) {
      return null;
    }

    const reactionsEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("reactions"),
    );
    return { actions: reactionsEnabled ? ["send", "react"] : ["send"] };
  },
  supportsAction: ({ action }) => action === "react",
  prepareSendPayload: ({ ctx, payload, replyToId, replyToIdSource }) => {
    if (ctx.action !== "send") {
      return null;
    }
    const normalizedReplyToId = replyToId?.trim();
    if (!normalizedReplyToId) {
      return payload;
    }
    return replyToIdSource === "implicit"
      ? payload
      : { ...payload, replyToId: normalizedReplyToId };
  },

  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    toolContext,
    assertDirectAdapterHandoff,
  }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (action === "react") {
      const account = resolveSignalAccount({ cfg, accountId });
      if (!account.enabled) {
        throw new Error(`Signal account "${account.accountId}" is disabled.`);
      }
      if (!account.configured) {
        throw new Error(`Signal account "${account.accountId}" is not configured.`);
      }

      const reactionLevelInfo = resolveSignalReactionLevel({
        cfg,
        accountId: account.accountId,
      });
      if (!reactionLevelInfo.agentReactionsEnabled) {
        throw new Error(
          `Signal agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). ` +
            `Set channels.signal.reactionLevel to "minimal" or "extensive" to enable.`,
        );
      }

      const isActionEnabled = createActionGate(account.config.actions);
      if (!isActionEnabled("reactions")) {
        throw new Error("Signal reactions are disabled via actions.reactions.");
      }

      const recipientTarget = readStringParam(params, "to", {
        required: true,
        label: "recipient (UUID, phone number, or group)",
      })
        .trim()
        .replace(/^signal:/i, "")
        .trim();
      const isGroup = normalizeLowercaseStringOrEmpty(recipientTarget).startsWith(GROUP_PREFIX);
      const groupId = isGroup ? recipientTarget.slice(GROUP_PREFIX.length).trim() : undefined;
      const recipient =
        !isGroup && recipientTarget ? normalizeSignalReactionRecipient(recipientTarget) : undefined;
      if (!recipient && !groupId) {
        throw new Error("recipient or group required");
      }

      const messageIdRaw = resolveReactionMessageId({ args: params, toolContext });
      const messageId = messageIdRaw != null ? String(messageIdRaw) : undefined;
      if (!messageId) {
        throw new Error(
          "messageId (timestamp) required. Provide messageId explicitly or react to the current inbound message.",
        );
      }
      const targetAuthor = readStringParam(params, "targetAuthor");
      const targetAuthorUuid = readStringParam(params, "targetAuthorUuid");
      if (groupId && !targetAuthor && !targetAuthorUuid) {
        throw new Error("targetAuthor or targetAuthorUuid required for group reactions.");
      }

      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;

      const timestamp = parseStrictNonNegativeInteger(messageId);
      if (timestamp === undefined) {
        throw new Error(`Invalid messageId: ${messageId}. Expected numeric timestamp.`);
      }

      if (!emoji) {
        throw new Error(`Emoji required to ${remove ? "remove" : "add"} reaction.`);
      }
      const mutateReaction = remove ? removeReactionSignal : sendReactionSignal;
      await mutateReaction(recipient ?? "", timestamp, emoji, {
        cfg,
        accountId: account.accountId,
        groupId,
        targetAuthor,
        targetAuthorUuid,
        ...(assertDirectAdapterHandoff ? { assertDirectAdapterHandoff } : {}),
      });
      return jsonResult({ ok: true, [remove ? "removed" : "added"]: emoji });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
