import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { TelegramBotFixtureMocks } from "./bot-module-mocks.test-support.js";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";
import {
  deliverReplies,
  deliverStructuredReplies,
  emitTelegramMessageSentHooks,
} from "./bot/delivery.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { editMessageTelegram } from "./send.js";

// These fixtures exercise direct delivery; durable-owner proof has its own fixture.
export const telegramDirectDeliveryDepsForTest = {
  recordChannelActivity,
  loadWebMedia,
  syncTelegramMenuCommands,
  createTelegramDraftStream,
  deliverReplies,
  deliverStructuredReplies,
  async deliverStructuredInboundReplyWithMessageSendContext() {
    return { status: "unsupported", reason: "missing_outbound_handler" };
  },
  emitTelegramMessageSentHooks,
  editMessageTelegram,
  recordOutboundMessageForPromptContext,
  createChannelMessageReplyPipeline,
  resolveApproval() {
    throw new Error("Direct-delivery fixtures do not resolve approvals");
  },
} satisfies Partial<TelegramBotFixtureMocks>;
