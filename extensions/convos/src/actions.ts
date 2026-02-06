import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam, readReactionParams } from "openclaw/plugin-sdk";
import { listConvosAccountIds, resolveConvosAccount, type CoreConfig } from "./accounts.js";
import { getClientForAccount } from "./outbound.js";

export const convosMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const ids = listConvosAccountIds(cfg as CoreConfig);
    if (ids.length === 0) {
      return [];
    }
    const actions: ChannelMessageActionName[] = ["send", "react", "channel-create", "channel-join"];
    return actions;
  },

  supportsButtons: () => false,

  handleAction: async ({ action, params, cfg, accountId }) => {
    const account = resolveConvosAccount({ cfg: cfg as CoreConfig, accountId });
    const client = getClientForAccount(account.accountId);
    if (!client) {
      throw new Error(`Convos client not running for account ${account.accountId}`);
    }

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const message = readStringParam(params, "message", { required: true, allowEmpty: true });
      const result = await client.sendMessage(to!, message!);
      return jsonResult({ ok: true, to, messageId: result.messageId ?? `convos-${Date.now()}` });
    }

    if (action === "react") {
      const conversationId = readStringParam(params, "conversationId", { required: true });
      const messageId = readStringParam(params, "messageId", { required: true });
      const { emoji, remove } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Convos reaction.",
      });
      const result = await client.react(conversationId!, messageId!, emoji, remove);
      return jsonResult({ ok: true, action: result.action, emoji });
    }

    if (action === "channel-create") {
      const name = readStringParam(params, "name") ?? undefined;
      const result = await client.createConversation(name);
      return jsonResult({
        ok: true,
        conversationId: result.conversationId,
        inviteUrl: result.inviteUrl,
      });
    }

    if (action === "channel-join") {
      const inviteUrl = readStringParam(params, "inviteUrl", { required: true });
      const result = await client.joinConversation(inviteUrl!);
      return jsonResult({
        ok: true,
        status: result.status,
        conversationId: result.conversationId,
      });
    }

    throw new Error(`Action "${action}" is not supported for Convos.`);
  },
};
