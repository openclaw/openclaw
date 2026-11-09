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
import { sendMessageSignal } from "./send.js";

const providerId = "signal";

// Signal clients aim every later edit at the newest revision: Signal-Android moves reactions
// and pins from the revision an edit names, so re-targeting the original drops them. Each
// timestamp in an edit chain maps to the chain's newest revision. In-process only: after a
// restart the next edit targets whatever messageId the caller passes (accepted edge case).
const EDIT_CHAIN_LIMIT = 512;
const signalEditChains = new Map<string, { latest: number }>();

function rememberSignalEdit(key: (timestamp: number) => string, edited: number, revision: number) {
  const chain = signalEditChains.get(key(edited)) ?? { latest: revision };
  chain.latest = revision;
  for (const timestamp of [edited, revision]) {
    signalEditChains.delete(key(timestamp));
    signalEditChains.set(key(timestamp), chain);
  }
  while (signalEditChains.size > EDIT_CHAIN_LIMIT) {
    signalEditChains.delete(signalEditChains.keys().next().value as string);
  }
}
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
    return { actions: reactionsEnabled ? ["send", "edit", "react"] : ["send", "edit"] };
  },
  supportsAction: ({ action }) => action === "react" || action === "edit",
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

    if (action === "edit") {
      // Signal edits replace the text of an earlier message from this account, in place.
      const account = resolveSignalAccount({ cfg, accountId });
      if (!account.enabled || !account.configured) {
        throw new Error(`Signal account "${account.accountId}" is not enabled and configured.`);
      }
      const to = readStringParam(params, "to", {
        required: true,
        label: "recipient (UUID, phone number, or group)",
      });
      const messageId = readStringParam(params, "messageId", { required: true });
      const timestamp = parseStrictNonNegativeInteger(messageId);
      if (timestamp === undefined) {
        throw new Error(`Invalid messageId: ${messageId}. Expected numeric timestamp.`);
      }
      const text =
        readStringParam(params, "text") ??
        readStringParam(params, "newText") ??
        readStringParam(params, "message");
      if (!text) {
        throw new Error("Signal edit requires text, newText, or message.");
      }
      const chainKey = (ts: number) => `${account.accountId}\u0000${to}\u0000${ts}`;
      const result = await sendMessageSignal(to, text, {
        cfg,
        accountId: account.accountId,
        editTimestamp: signalEditChains.get(chainKey(timestamp))?.latest ?? timestamp,
        ...(assertDirectAdapterHandoff ? { assertDirectAdapterHandoff } : {}),
      });
      const revision = parseStrictNonNegativeInteger(result.messageId);
      if (revision !== undefined) {
        rememberSignalEdit(chainKey, timestamp, revision);
      }
      return jsonResult({ ok: true, edited: messageId, messageId: result.messageId });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
