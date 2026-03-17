import {
  BLUEBUBBLES_ACTION_NAMES,
  BLUEBUBBLES_ACTIONS,
  createActionGate,
  extractToolSend,
  jsonResult,
  readNumberParam,
  readBooleanParam,
  readReactionParams,
  readStringParam
} from "openclaw/plugin-sdk/bluebubbles";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { sendBlueBubblesAttachment } from "./attachments.js";
import {
  editBlueBubblesMessage,
  unsendBlueBubblesMessage,
  renameBlueBubblesChat,
  setGroupIconBlueBubbles,
  addBlueBubblesParticipant,
  removeBlueBubblesParticipant,
  leaveBlueBubblesChat
} from "./chat.js";
import { resolveBlueBubblesMessageId } from "./monitor.js";
import { getCachedBlueBubblesPrivateApiStatus, isMacOS26OrHigher } from "./probe.js";
import { sendBlueBubblesReaction } from "./reactions.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { resolveChatGuidForTarget, sendMessageBlueBubbles } from "./send.js";
import { normalizeBlueBubblesHandle, parseBlueBubblesTarget } from "./targets.js";
const providerId = "bluebubbles";
function mapTarget(raw) {
  const parsed = parseBlueBubblesTarget(raw);
  if (parsed.kind === "chat_guid") {
    return { kind: "chat_guid", chatGuid: parsed.chatGuid };
  }
  if (parsed.kind === "chat_id") {
    return { kind: "chat_id", chatId: parsed.chatId };
  }
  if (parsed.kind === "chat_identifier") {
    return { kind: "chat_identifier", chatIdentifier: parsed.chatIdentifier };
  }
  return {
    kind: "handle",
    address: normalizeBlueBubblesHandle(parsed.to),
    service: parsed.service
  };
}
function readMessageText(params) {
  return readStringParam(params, "text") ?? readStringParam(params, "message");
}
const SUPPORTED_ACTIONS = new Set(BLUEBUBBLES_ACTION_NAMES);
const PRIVATE_API_ACTIONS = /* @__PURE__ */ new Set([
  "react",
  "edit",
  "unsend",
  "reply",
  "sendWithEffect",
  "renameGroup",
  "setGroupIcon",
  "addParticipant",
  "removeParticipant",
  "leaveGroup"
]);
const bluebubblesMessageActions = {
  listActions: ({ cfg }) => {
    const account = resolveBlueBubblesAccount({ cfg });
    if (!account.enabled || !account.configured) {
      return [];
    }
    const gate = createActionGate(cfg.channels?.bluebubbles?.actions);
    const actions = /* @__PURE__ */ new Set();
    const macOS26 = isMacOS26OrHigher(account.accountId);
    const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(account.accountId);
    for (const action of BLUEBUBBLES_ACTION_NAMES) {
      const spec = BLUEBUBBLES_ACTIONS[action];
      if (!spec?.gate) {
        continue;
      }
      if (privateApiStatus === false && PRIVATE_API_ACTIONS.has(action)) {
        continue;
      }
      if ("unsupportedOnMacOS26" in spec && spec.unsupportedOnMacOS26 && macOS26) {
        continue;
      }
      if (gate(spec.gate)) {
        actions.add(action);
      }
    }
    return Array.from(actions);
  },
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    const account = resolveBlueBubblesAccount({
      cfg,
      accountId: accountId ?? void 0
    });
    const baseUrl = normalizeSecretInputString(account.config.serverUrl);
    const password = normalizeSecretInputString(account.config.password);
    const opts = { cfg, accountId: accountId ?? void 0 };
    const assertPrivateApiEnabled = () => {
      if (getCachedBlueBubblesPrivateApiStatus(account.accountId) === false) {
        throw new Error(
          `BlueBubbles ${action} requires Private API, but it is disabled on the BlueBubbles server.`
        );
      }
    };
    const resolveChatGuid = async () => {
      const chatGuid = readStringParam(params, "chatGuid");
      if (chatGuid?.trim()) {
        return chatGuid.trim();
      }
      const chatIdentifier = readStringParam(params, "chatIdentifier");
      const chatId = readNumberParam(params, "chatId", { integer: true });
      const to = readStringParam(params, "to");
      const contextTarget = toolContext?.currentChannelId?.trim();
      const target = chatIdentifier?.trim() ? {
        kind: "chat_identifier",
        chatIdentifier: chatIdentifier.trim()
      } : typeof chatId === "number" ? { kind: "chat_id", chatId } : to ? mapTarget(to) : contextTarget ? mapTarget(contextTarget) : null;
      if (!target) {
        throw new Error(`BlueBubbles ${action} requires chatGuid, chatIdentifier, chatId, or to.`);
      }
      if (!baseUrl || !password) {
        throw new Error(`BlueBubbles ${action} requires serverUrl and password.`);
      }
      const resolved = await resolveChatGuidForTarget({ baseUrl, password, target });
      if (!resolved) {
        throw new Error(`BlueBubbles ${action} failed: chatGuid not found for target.`);
      }
      return resolved;
    };
    if (action === "react") {
      assertPrivateApiEnabled();
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a BlueBubbles reaction."
      });
      if (isEmpty && !remove) {
        throw new Error(
          "BlueBubbles react requires emoji parameter. Use action=react with emoji=<emoji> and messageId=<message_id>."
        );
      }
      const rawMessageId = readStringParam(params, "messageId");
      if (!rawMessageId) {
        throw new Error(
          "BlueBubbles react requires messageId parameter (the message ID to react to). Use action=react with messageId=<message_id>, emoji=<emoji>, and to/chatGuid to identify the chat."
        );
      }
      const messageId = resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await resolveChatGuid();
      await sendBlueBubblesReaction({
        chatGuid: resolvedChatGuid,
        messageGuid: messageId,
        emoji,
        remove: remove || void 0,
        partIndex: typeof partIndex === "number" ? partIndex : void 0,
        opts
      });
      return jsonResult({ ok: true, ...remove ? { removed: true } : { added: emoji } });
    }
    if (action === "edit") {
      assertPrivateApiEnabled();
      if (isMacOS26OrHigher(accountId ?? void 0)) {
        throw new Error(
          "BlueBubbles edit is not supported on macOS 26 or higher. Apple removed the ability to edit iMessages in this version."
        );
      }
      const rawMessageId = readStringParam(params, "messageId");
      const newText = readStringParam(params, "text") ?? readStringParam(params, "newText") ?? readStringParam(params, "message");
      if (!rawMessageId || !newText) {
        const missing = [];
        if (!rawMessageId) {
          missing.push("messageId (the message ID to edit)");
        }
        if (!newText) {
          missing.push("text (the new message content)");
        }
        throw new Error(
          `BlueBubbles edit requires: ${missing.join(", ")}. Use action=edit with messageId=<message_id>, text=<new_content>.`
        );
      }
      const messageId = resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const backwardsCompatMessage = readStringParam(params, "backwardsCompatMessage");
      await editBlueBubblesMessage(messageId, newText, {
        ...opts,
        partIndex: typeof partIndex === "number" ? partIndex : void 0,
        backwardsCompatMessage: backwardsCompatMessage ?? void 0
      });
      return jsonResult({ ok: true, edited: rawMessageId });
    }
    if (action === "unsend") {
      assertPrivateApiEnabled();
      const rawMessageId = readStringParam(params, "messageId");
      if (!rawMessageId) {
        throw new Error(
          "BlueBubbles unsend requires messageId parameter (the message ID to unsend). Use action=unsend with messageId=<message_id>."
        );
      }
      const messageId = resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      await unsendBlueBubblesMessage(messageId, {
        ...opts,
        partIndex: typeof partIndex === "number" ? partIndex : void 0
      });
      return jsonResult({ ok: true, unsent: rawMessageId });
    }
    if (action === "reply") {
      assertPrivateApiEnabled();
      const rawMessageId = readStringParam(params, "messageId");
      const text = readMessageText(params);
      const to = readStringParam(params, "to") ?? readStringParam(params, "target");
      if (!rawMessageId || !text || !to) {
        const missing = [];
        if (!rawMessageId) {
          missing.push("messageId (the message ID to reply to)");
        }
        if (!text) {
          missing.push("text or message (the reply message content)");
        }
        if (!to) {
          missing.push("to or target (the chat target)");
        }
        throw new Error(
          `BlueBubbles reply requires: ${missing.join(", ")}. Use action=reply with messageId=<message_id>, message=<your reply>, target=<chat_target>.`
        );
      }
      const messageId = resolveBlueBubblesMessageId(rawMessageId, { requireKnownShortId: true });
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const result = await sendMessageBlueBubbles(to, text, {
        ...opts,
        replyToMessageGuid: messageId,
        replyToPartIndex: typeof partIndex === "number" ? partIndex : void 0
      });
      return jsonResult({ ok: true, messageId: result.messageId, repliedTo: rawMessageId });
    }
    if (action === "sendWithEffect") {
      assertPrivateApiEnabled();
      const text = readMessageText(params);
      const to = readStringParam(params, "to") ?? readStringParam(params, "target");
      const effectId = readStringParam(params, "effectId") ?? readStringParam(params, "effect");
      if (!text || !to || !effectId) {
        const missing = [];
        if (!text) {
          missing.push("text or message (the message content)");
        }
        if (!to) {
          missing.push("to or target (the chat target)");
        }
        if (!effectId) {
          missing.push(
            "effectId or effect (e.g., slam, loud, gentle, invisible-ink, confetti, lasers, fireworks, balloons, heart)"
          );
        }
        throw new Error(
          `BlueBubbles sendWithEffect requires: ${missing.join(", ")}. Use action=sendWithEffect with message=<message>, target=<chat_target>, effectId=<effect_name>.`
        );
      }
      const result = await sendMessageBlueBubbles(to, text, {
        ...opts,
        effectId
      });
      return jsonResult({ ok: true, messageId: result.messageId, effect: effectId });
    }
    if (action === "renameGroup") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
      if (!displayName) {
        throw new Error("BlueBubbles renameGroup requires displayName or name parameter.");
      }
      await renameBlueBubblesChat(resolvedChatGuid, displayName, opts);
      return jsonResult({ ok: true, renamed: resolvedChatGuid, displayName });
    }
    if (action === "setGroupIcon") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      const base64Buffer = readStringParam(params, "buffer");
      const filename = readStringParam(params, "filename") ?? readStringParam(params, "name") ?? "icon.png";
      const contentType = readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
      if (!base64Buffer) {
        throw new Error(
          "BlueBubbles setGroupIcon requires an image. Use action=setGroupIcon with media=<image_url> or path=<local_file_path> to set the group icon."
        );
      }
      const buffer = Uint8Array.from(atob(base64Buffer), (c) => c.charCodeAt(0));
      await setGroupIconBlueBubbles(resolvedChatGuid, buffer, filename, {
        ...opts,
        contentType: contentType ?? void 0
      });
      return jsonResult({ ok: true, chatGuid: resolvedChatGuid, iconSet: true });
    }
    if (action === "addParticipant") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error("BlueBubbles addParticipant requires address or participant parameter.");
      }
      await addBlueBubblesParticipant(resolvedChatGuid, address, opts);
      return jsonResult({ ok: true, added: address, chatGuid: resolvedChatGuid });
    }
    if (action === "removeParticipant") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error("BlueBubbles removeParticipant requires address or participant parameter.");
      }
      await removeBlueBubblesParticipant(resolvedChatGuid, address, opts);
      return jsonResult({ ok: true, removed: address, chatGuid: resolvedChatGuid });
    }
    if (action === "leaveGroup") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await resolveChatGuid();
      await leaveBlueBubblesChat(resolvedChatGuid, opts);
      return jsonResult({ ok: true, left: resolvedChatGuid });
    }
    if (action === "sendAttachment") {
      const to = readStringParam(params, "to", { required: true });
      const filename = readStringParam(params, "filename", { required: true });
      const caption = readStringParam(params, "caption");
      const contentType = readStringParam(params, "contentType") ?? readStringParam(params, "mimeType");
      const asVoice = readBooleanParam(params, "asVoice");
      const base64Buffer = readStringParam(params, "buffer");
      const filePath = readStringParam(params, "path") ?? readStringParam(params, "filePath");
      let buffer;
      if (base64Buffer) {
        buffer = Uint8Array.from(atob(base64Buffer), (c) => c.charCodeAt(0));
      } else if (filePath) {
        throw new Error(
          "BlueBubbles sendAttachment: filePath not supported in action, provide buffer as base64."
        );
      } else {
        throw new Error("BlueBubbles sendAttachment requires buffer (base64) parameter.");
      }
      const result = await sendBlueBubblesAttachment({
        to,
        buffer,
        filename,
        contentType: contentType ?? void 0,
        caption: caption ?? void 0,
        asVoice: asVoice ?? void 0,
        opts
      });
      return jsonResult({ ok: true, messageId: result.messageId });
    }
    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  }
};
export {
  bluebubblesMessageActions
};
