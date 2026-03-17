import {
  createActionGate,
  extractToolSend,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam
} from "openclaw/plugin-sdk/googlechat";
import { listEnabledGoogleChatAccounts, resolveGoogleChatAccount } from "./accounts.js";
import {
  createGoogleChatReaction,
  deleteGoogleChatReaction,
  listGoogleChatReactions,
  sendGoogleChatMessage,
  uploadGoogleChatAttachment
} from "./api.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";
const providerId = "googlechat";
function listEnabledAccounts(cfg) {
  return listEnabledGoogleChatAccounts(cfg).filter(
    (account) => account.enabled && account.credentialSource !== "none"
  );
}
function isReactionsEnabled(accounts, cfg) {
  for (const account of accounts) {
    const gate = createActionGate(
      account.config.actions ?? cfg.channels?.["googlechat"]?.actions
    );
    if (gate("reactions")) {
      return true;
    }
  }
  return false;
}
function resolveAppUserNames(account) {
  return new Set(["users/app", account.config.botUser?.trim()].filter(Boolean));
}
const googlechatMessageActions = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const actions = /* @__PURE__ */ new Set([]);
    actions.add("send");
    if (isReactionsEnabled(accounts, cfg)) {
      actions.add("react");
      actions.add("reactions");
    }
    return Array.from(actions);
  },
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    const account = resolveGoogleChatAccount({
      cfg,
      accountId
    });
    if (account.credentialSource === "none") {
      throw new Error("Google Chat credentials are missing.");
    }
    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });
      if (mediaUrl) {
        const core = getGoogleChatRuntime();
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await core.channel.media.fetchRemoteMedia({ url: mediaUrl, maxBytes });
        const upload = await uploadGoogleChatAttachment({
          account,
          space,
          filename: loaded.fileName ?? "attachment",
          buffer: loaded.buffer,
          contentType: loaded.contentType
        });
        await sendGoogleChatMessage({
          account,
          space,
          text: content,
          thread: threadId ?? void 0,
          attachments: upload.attachmentUploadToken ? [
            {
              attachmentUploadToken: upload.attachmentUploadToken,
              contentName: loaded.fileName
            }
          ] : void 0
        });
        return jsonResult({ ok: true, to: space });
      }
      await sendGoogleChatMessage({
        account,
        space,
        text: content,
        thread: threadId ?? void 0
      });
      return jsonResult({ ok: true, to: space });
    }
    if (action === "react") {
      const messageName = readStringParam(params, "messageId", { required: true });
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Google Chat reaction."
      });
      if (remove || isEmpty) {
        const reactions = await listGoogleChatReactions({ account, messageName });
        const appUsers = resolveAppUserNames(account);
        const toRemove = reactions.filter((reaction2) => {
          const userName = reaction2.user?.name?.trim();
          if (appUsers.size > 0 && !appUsers.has(userName ?? "")) {
            return false;
          }
          if (emoji) {
            return reaction2.emoji?.unicode === emoji;
          }
          return true;
        });
        for (const reaction2 of toRemove) {
          if (!reaction2.name) {
            continue;
          }
          await deleteGoogleChatReaction({ account, reactionName: reaction2.name });
        }
        return jsonResult({ ok: true, removed: toRemove.length });
      }
      const reaction = await createGoogleChatReaction({
        account,
        messageName,
        emoji
      });
      return jsonResult({ ok: true, reaction });
    }
    if (action === "reactions") {
      const messageName = readStringParam(params, "messageId", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const reactions = await listGoogleChatReactions({
        account,
        messageName,
        limit: limit ?? void 0
      });
      return jsonResult({ ok: true, reactions });
    }
    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  }
};
export {
  googlechatMessageActions
};
