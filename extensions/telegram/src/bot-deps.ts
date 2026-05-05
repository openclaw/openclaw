import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { buildModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { loadSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { listSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";
import { deliverReplies, emitInternalMessageSentHook } from "./bot/delivery.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { resolveTelegramExecApproval } from "./exec-approval-resolver.js";
import { editMessageTelegram } from "./send.js";
import { wasSentByBot } from "./sent-message-cache.js";
import {
  markTelegramInflightCompleted,
  markTelegramInflightDispatched,
  markTelegramInflightFailed,
  markStaleTelegramInflightInterrupted,
} from "./telegram-reliability-store.js";

export type TelegramBotDeps = {
  getRuntimeConfig: typeof getRuntimeConfig;
  resolveStorePath: typeof resolveStorePath;
  loadSessionStore?: typeof loadSessionStore;
  readChannelAllowFromStore: typeof readChannelAllowFromStore;
  upsertChannelPairingRequest: typeof upsertChannelPairingRequest;
  enqueueSystemEvent: typeof enqueueSystemEvent;
  dispatchReplyWithBufferedBlockDispatcher: typeof dispatchReplyWithBufferedBlockDispatcher;
  loadWebMedia?: typeof loadWebMedia;
  buildModelsProviderData: typeof buildModelsProviderData;
  listSkillCommandsForAgents: typeof listSkillCommandsForAgents;
  syncTelegramMenuCommands?: typeof syncTelegramMenuCommands;
  wasSentByBot: typeof wasSentByBot;
  resolveExecApproval?: typeof resolveTelegramExecApproval;
  createTelegramDraftStream?: typeof createTelegramDraftStream;
  deliverReplies?: typeof deliverReplies;
  emitInternalMessageSentHook?: typeof emitInternalMessageSentHook;
  editMessageTelegram?: typeof editMessageTelegram;
  createChannelReplyPipeline?: typeof createChannelReplyPipeline;
  markTelegramInflightDispatched?: typeof markTelegramInflightDispatched;
  markTelegramInflightCompleted?: typeof markTelegramInflightCompleted;
  markTelegramInflightFailed?: typeof markTelegramInflightFailed;
  markStaleTelegramInflightInterrupted?: typeof markStaleTelegramInflightInterrupted;
};

export const defaultTelegramBotDeps: TelegramBotDeps = {
  get getRuntimeConfig() {
    return getRuntimeConfig;
  },
  get resolveStorePath() {
    return resolveStorePath;
  },
  get readChannelAllowFromStore() {
    return readChannelAllowFromStore;
  },
  get loadSessionStore() {
    return loadSessionStore;
  },
  get upsertChannelPairingRequest() {
    return upsertChannelPairingRequest;
  },
  get enqueueSystemEvent() {
    return enqueueSystemEvent;
  },
  get dispatchReplyWithBufferedBlockDispatcher() {
    return dispatchReplyWithBufferedBlockDispatcher;
  },
  get loadWebMedia() {
    return loadWebMedia;
  },
  get buildModelsProviderData() {
    return buildModelsProviderData;
  },
  get listSkillCommandsForAgents() {
    return listSkillCommandsForAgents;
  },
  get syncTelegramMenuCommands() {
    return syncTelegramMenuCommands;
  },
  get wasSentByBot() {
    return wasSentByBot;
  },
  get resolveExecApproval() {
    return resolveTelegramExecApproval;
  },
  get createTelegramDraftStream() {
    return createTelegramDraftStream;
  },
  get deliverReplies() {
    return deliverReplies;
  },
  get emitInternalMessageSentHook() {
    return emitInternalMessageSentHook;
  },
  get editMessageTelegram() {
    return editMessageTelegram;
  },
  get createChannelReplyPipeline() {
    return createChannelReplyPipeline;
  },
  get markTelegramInflightDispatched() {
    return markTelegramInflightDispatched;
  },
  get markTelegramInflightCompleted() {
    return markTelegramInflightCompleted;
  },
  get markTelegramInflightFailed() {
    return markTelegramInflightFailed;
  },
  get markStaleTelegramInflightInterrupted() {
    return markStaleTelegramInflightInterrupted;
  },
};
