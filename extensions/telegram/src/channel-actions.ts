import {
  readNumberParam,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
} from "../../../src/agents/tools/common.js";
import { handleTelegramAction } from "../../../src/agents/tools/telegram-actions.js";
import { resolveReactionMessageId } from "../../../src/channels/plugins/actions/reaction-message-id.js";
import {
  createUnionActionGate,
  listTokenSourcedAccounts,
} from "../../../src/channels/plugins/actions/shared.js";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../../../src/channels/plugins/types.js";
import type { TelegramActionConfig } from "../../../src/config/types.telegram.js";
import { readBooleanParam } from "../../../src/plugin-sdk/boolean-param.js";
import { extractToolSend } from "../../../src/plugin-sdk/tool-send.js";
import { resolveTelegramPollVisibility } from "../../../src/poll-params.js";
import {
  createTelegramActionGate,
  listEnabledTelegramAccounts,
  resolveTelegramPollActionGateState,
} from "./accounts.js";
import { isTelegramInlineButtonsEnabled } from "./inline-buttons.js";

const providerId = "telegram";

function readTelegramSendParams(params: Record<string, unknown>) {
  const to = readStringParam(params, "to", { required: true });
  const mediaUrl = readStringParam(params, "media", { trim: false });
  const message = readStringParam(params, "message", { required: !mediaUrl, allowEmpty: true });
  const caption = readStringParam(params, "caption", { allowEmpty: true });
  const content = message || caption || "";
  const replyTo = readStringParam(params, "replyTo");
  const threadId = readStringParam(params, "threadId");
  const buttons = params.buttons;
  const asVoice = readBooleanParam(params, "asVoice");
  const silent = readBooleanParam(params, "silent");
  const quoteText = readStringParam(params, "quoteText");
  return {
    to,
    content,
    mediaUrl: mediaUrl ?? undefined,
    replyToMessageId: replyTo ?? undefined,
    messageThreadId: threadId ?? undefined,
    buttons,
    asVoice,
    silent,
    quoteText: quoteText ?? undefined,
  };
}

function readTelegramChatIdParam(params: Record<string, unknown>): string | number {
  return (
    readStringOrNumberParam(params, "chatId") ??
    readStringOrNumberParam(params, "channelId") ??
    readStringParam(params, "to", { required: true })
  );
}

function readTelegramMessageIdParam(params: Record<string, unknown>): number {
  const messageId = readNumberParam(params, "messageId", {
    required: true,
    integer: true,
  });
  if (typeof messageId !== "number") {
    throw new Error("messageId is required.");
  }
  return messageId;
}

export const telegramMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listTokenSourcedAccounts(listEnabledTelegramAccounts(cfg));
    if (accounts.length === 0) {
      return [];
    }
    // Union of all accounts' action gates (any account enabling an action makes it available)
    const gate = createUnionActionGate(accounts, (account) =>
      createTelegramActionGate({
        cfg,
        accountId: account.accountId,
      }),
    );
    const isEnabled = (key: keyof TelegramActionConfig, defaultValue = true) =>
      gate(key, defaultValue);
    const actions = new Set<ChannelMessageActionName>(["send"]);
    const pollEnabledForAnyAccount = accounts.some((account) => {
      const accountGate = createTelegramActionGate({
        cfg,
        accountId: account.accountId,
      });
      return resolveTelegramPollActionGateState(accountGate).enabled;
    });
    if (pollEnabledForAnyAccount) {
      actions.add("poll");
    }
    if (isEnabled("reactions")) {
      actions.add("react");
    }
    if (isEnabled("deleteMessage")) {
      actions.add("delete");
    }
    if (isEnabled("editMessage")) {
      actions.add("edit");
    }
    if (isEnabled("sticker", false)) {
      actions.add("sticker");
      actions.add("sticker-search");
    }
    if (isEnabled("createForumTopic")) {
      actions.add("topic-create");
    }
    return Array.from(actions);
  },
  supportsButtons: ({ cfg }) => {
    const accounts = listTokenSourcedAccounts(listEnabledTelegramAccounts(cfg));
    if (accounts.length === 0) {
      return false;
    }
    return accounts.some((account) =>
      isTelegramInlineButtonsEnabled({ cfg, accountId: account.accountId }),
    );
  },
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async ({ action, params, cfg, accountId, mediaLocalRoots, toolContext }) => {
    if (action === "send") {
      const sendParams = readTelegramSendParams(params);
      return await handleTelegramAction(
        {
          action: "sendMessage",
          ...sendParams,
          accountId: accountId ?? undefined,
        },
        cfg,
        { mediaLocalRoots },
      );
    }

    if (action === "react") {
      const messageId = resolveReactionMessageId({ args: params, toolContext });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = readBooleanParam(params, "remove");
      return await handleTelegramAction(
        {
          action: "react",
          chatId: readTelegramChatIdParam(params),
          messageId,
          emoji,
          remove,
          accountId: accountId ?? undefined,
        },
        cfg,
        { mediaLocalRoots },
      );
    }

    if (action === "poll") {
      const to = readStringParam(params, "to", { required: true });
      const question = readStringParam(params, "pollQuestion", { required: true });
      const answers = readStringArrayParam(params, "pollOption", { required: true });
      const durationHours = readNumberParam(params, "pollDurationHours", {
        integer: true,
        strict: true,
      });
      const durationSeconds = readNumberParam(params, "pollDurationSeconds", {
        integer: true,
        strict: true,
      });
      const replyToMessageId = readNumberParam(params, "replyTo", { integer: true });
      const messageThreadId = readNumberParam(params, "threadId", { integer: true });
      const allowMultiselect = readBooleanParam(params, "pollMulti");
      const pollAnonymous = readBooleanParam(params, "pollAnonymous");
      const pollPublic = readBooleanParam(params, "pollPublic");
      const isAnonymous = resolveTelegramPollVisibility({ pollAnonymous, pollPublic });
      const silent = readBooleanParam(params, "silent");
      return await handleTelegramAction(
        {
          action: "poll",
          to,
          question,
          answers,
          allowMultiselect,
          durationHours: durationHours ?? undefined,
          durationSeconds: durationSeconds ?? undefined,
          replyToMessageId: replyToMessageId ?? undefined,
          messageThreadId: messageThreadId ?? undefined,
          isAnonymous,
          silent,
          accountId: accountId ?? undefined,
        },
        cfg,
        { mediaLocalRoots },
      );
    }

    if (action === "delete") {
      const chatId = readTelegramChatIdParam(params);
      const messageId = readTelegramMessageIdParam(params);
      return await handleTelegramAction(
        {
          action: "deleteMessage",
          chatId,
          messageId,
          accountId: accountId ?? undefined,
        },
        cfg,
        { mediaLocalRoots },
      );
    }

    if (action === "edit") {
      const chatId = readTelegramChatIdParam(params);
      const messageId = readTelegramMessageIdParam(params);
      const message = readStringParam(params, "message", { required: true, allowEmpty: false });
      const buttons = params.buttons;
      return await handleTelegramAction(
        {
          action: "editMessage",
          chatId,
          messageId,
          content: message,
          buttons,
          accountId: accountId ?? undefined,
        },
        cfg,
        { mediaLocalRoots },
      );
    }

    if (action === "sticker") {
      const to =
        readStringParam(params, "to") ?? readStringParam(params, "target", { required: true });
      // Accept stickerId (array from shared schema) and use first element as fileId
      const stickerIds = readStringArrayParam(params, "stickerId");
      const fileId = stickerIds?.[0] ?? readStringParam(params, "fileId", { required: true });
      const replyToMessageId = readNumberParam(params, "replyTo", { integer: true });
      const messageThreadId = readNumberParam(params, "threadId", { integer: true });
      return await handleTelegramAction(
        {
          action: "sendSticker",
          to,
          fileId,
          replyToMessageId: replyToMessageId ?? undefined,
          messageThreadId: messageThreadId ?? undefined,
          accountId: accountId ?? undefined,
        },
        cfg,
        { mediaLocalRoots },
      );
    }

    if (action === "sticker-search") {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      return await handleTelegramAction(
        {
          action: "searchSticker",
          query,
          limit: limit ?? undefined,
          accountId: accountId ?? undefined,
        },
        cfg,
        { mediaLocalRoots },
      );
    }

    if (action === "topic-create") {
      const chatId = readTelegramChatIdParam(params);
      const name = readStringParam(params, "name", { required: true });
      const iconColor = readNumberParam(params, "iconColor", { integer: true });
      const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
      return await handleTelegramAction(
        {
          action: "createForumTopic",
          chatId,
          name,
          iconColor: iconColor ?? undefined,
          iconCustomEmojiId: iconCustomEmojiId ?? undefined,
          accountId: accountId ?? undefined,
        },
        cfg,
        { mediaLocalRoots },
      );
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
