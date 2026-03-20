import { loadConfig, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildModelsProviderData,
  dispatchReplyWithBufferedBlockDispatcher,
  listSkillCommandsForAgents,
} from "openclaw/plugin-sdk/reply-runtime";
import { wasSentByBot } from "./sent-message-cache.js";

export type TelegramBotDeps = {
  loadConfig: typeof loadConfig;
  resolveStorePath: typeof resolveStorePath;
  readChannelAllowFromStore: typeof readChannelAllowFromStore;
  upsertChannelPairingRequest: typeof upsertChannelPairingRequest;
  enqueueSystemEvent: typeof enqueueSystemEvent;
  buildModelsProviderData: typeof buildModelsProviderData;
  dispatchReplyWithBufferedBlockDispatcher: typeof dispatchReplyWithBufferedBlockDispatcher;
  listSkillCommandsForAgents: typeof listSkillCommandsForAgents;
  wasSentByBot: typeof wasSentByBot;
};

export const defaultTelegramBotDeps: TelegramBotDeps = {
  get loadConfig() {
    return loadConfig;
  },
  get resolveStorePath() {
    return resolveStorePath;
  },
  get readChannelAllowFromStore() {
    return readChannelAllowFromStore;
  },
  get upsertChannelPairingRequest() {
    return upsertChannelPairingRequest;
  },
  get enqueueSystemEvent() {
    return enqueueSystemEvent;
  },
  get buildModelsProviderData() {
    return buildModelsProviderData;
  },
  get dispatchReplyWithBufferedBlockDispatcher() {
    return dispatchReplyWithBufferedBlockDispatcher;
  },
  get listSkillCommandsForAgents() {
    return listSkillCommandsForAgents;
  },
  get wasSentByBot() {
    return wasSentByBot;
  },
};
