import {
  readNumberParam,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import { handleTelegramAction } from "openclaw/plugin-sdk/agent-runtime";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-runtime";
import {
  createMessageToolButtonsSchema,
  createTelegramPollExtraToolSchemas,
  createUnionActionGate,
  listTokenSourcedAccounts,
} from "openclaw/plugin-sdk/channel-runtime";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-runtime";
import type { TelegramActionConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveTelegramPollVisibility } from "openclaw/plugin-sdk/telegram";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import {
  createTelegramActionGate,
  listEnabledTelegramAccounts,
  resolveTelegramPollActionGateState,
} from "./accounts.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { isTelegramInlineButtonsEnabled } from "./inline-buttons.js";

const providerId = "telegram";

export const telegramMessageActionRuntime = {
  handleTelegramAction,
};

function resolveTelegramActionDiscovery(cfg: Parameters<typeof listEnabledTelegramAccounts>[0]) {
  const accounts = listTokenSourcedAccounts(listEnabledTelegramAccounts(cfg));
  if (accounts.length === 0) {
    return null;
  }
  const unionGate = createUnionActionGate(accounts, (account) =>
    createTelegramActionGate({
      cfg,
      accountId: account.accountId,
    }),
  );
  const pollEnabled = accounts.some((account) => {
    const accountGate = createTelegramActionGate({
      cfg,
      accountId: account.accountId,
    });
    return resolveTelegramPollActionGateState(accountGate).enabled;
  });
  const buttonsEnabled = accounts.some((account) =>
    isTelegramInlineButtonsEnabled({ cfg, accountId: account.accountId }),
  );
  return {
    isEnabled: (key: keyof TelegramActionConfig, defaultValue = true) =>
      unionGate(key, defaultValue),
    pollEnabled,
    buttonsEnabled,
  };
}

function describeTelegramMessageTool({
  cfg,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const discovery = resolveTelegramActionDiscovery(cfg);
  if (!discovery) {
    return {
      actions: [],
      capabilities: [],
      schema: null,
    };
  }
  const actions = new Set<ChannelMessageActionName>(["send"]);
  if (discovery.pollEnabled) {
    actions.add("poll");
  }
  if (discovery.isEnabled("reactions")) {
    actions.add("react");
  }
  if (discovery.isEnabled("deleteMessage")) {
    actions.add("delete");
  }
  if (discovery.isEnabled("editMessage")) {
    actions.add("edit");
  }
  if (discovery.isEnabled("sticker", false)) {
    actions.add("sticker");
    actions.add("sticker-search");
  }
  if (discovery.isEnabled("createForumTopic")) {
    actions.add("topic-create");
  }
  if (discovery.isEnabled("editForumTopic")) {
    actions.add("topic-edit");
  }
  const schema: ChannelMessageToolSchemaContribution[] = [];
  if (discovery.buttonsEnabled) {
    schema.push({
      properties: {
        buttons: createMessageToolButtonsSchema(),
      },
    });
  }
  if (discovery.pollEnabled) {
    schema.push({
      properties: createTelegramPollExtraToolSchemas(),
      visibility: "all-configured",
    });
  }
  return {
    actions: Array.from(actions),
    capabilities: discovery.buttonsEnabled ? ["interactive", "buttons"] : [],
    schema,
  };
}

function readTelegramSendParams(params: Record<string, unknown>) {
  const to = readStringParam(params, "to", { required: true });
  const mediaUrl = readStringParam(params, "media", { trim: false });
  const buttons = resolveTelegramInlineButtons({
    buttons: params.buttons as ReturnType<typeof resolveTelegramInlineButtons>,
    interactive: params.interactive,
  });
  const hasButtons = Array.isArray(buttons) && buttons.length > 0;
  const message = readStringParam(params, "message", {
    required: !mediaUrl && !hasButtons,
    allowEmpty: true,
  });
  const caption = readStringParam(params, "caption", { allowEmpty: true });
  const content = message || caption || "";
  const replyTo = readStringParam(params, "replyTo");
  const threadId = readStringParam(params, "threadId");
  const asVoice = readBooleanParam(params, "asVoice");
  const silent = readBooleanParam(params, "silent");
  const forceDocument = readBooleanParam(params, "forceDocument");
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
    forceDocument,
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
  describeMessageTool: describeTelegramMessageTool,
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async ({ action, params, cfg, accountId, mediaLocalRoots, toolContext }) => {
    if (action === "send") {
      const sendParams = readTelegramSendParams(params);
      return await telegramMessageActionRuntime.handleTelegramAction(
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
      return await telegramMessageActionRuntime.handleTelegramAction(
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
      return await telegramMessageActionRuntime.handleTelegramAction(
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
      return await telegramMessageActionRuntime.handleTelegramAction(
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
      return await telegramMessageActionRuntime.handleTelegramAction(
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
      return await telegramMessageActionRuntime.handleTelegramAction(
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
      return await telegramMessageActionRuntime.handleTelegramAction(
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
      return await telegramMessageActionRuntime.handleTelegramAction(
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

    if (action === "topic-edit") {
      const chatId = readTelegramChatIdParam(params);
      const messageThreadId =
        readNumberParam(params, "messageThreadId", { integer: true }) ??
        readNumberParam(params, "threadId", { integer: true });
      if (typeof messageThreadId !== "number") {
        throw new Error("messageThreadId or threadId is required.");
      }
      const name = readStringParam(params, "name");
      const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
      return await telegramMessageActionRuntime.handleTelegramAction(
        {
          action: "editForumTopic",
          chatId,
          messageThreadId,
          name: name ?? undefined,
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
