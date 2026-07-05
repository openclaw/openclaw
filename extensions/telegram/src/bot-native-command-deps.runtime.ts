// Telegram plugin module implements bot native command deps behavior.
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { getPluginCommandSpecs } from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { listSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import type { TelegramBotDeps } from "./bot-deps.js";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";
<<<<<<< HEAD
import { loadTelegramSendModule } from "./send-runtime.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

export type TelegramNativeCommandDeps = Pick<
  TelegramBotDeps,
  | "dispatchReplyWithBufferedBlockDispatcher"
  | "editMessageTelegram"
  | "getRuntimeConfig"
  | "listSkillCommandsForAgents"
  | "readChannelAllowFromStore"
  | "syncTelegramMenuCommands"
> & {
  getPluginCommandSpecs?: typeof getPluginCommandSpecs;
};

<<<<<<< HEAD
=======
let telegramSendRuntimePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendRuntime() {
  telegramSendRuntimePromise ??= import("./send.js");
  return await telegramSendRuntimePromise;
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export const defaultTelegramNativeCommandDeps: TelegramNativeCommandDeps = {
  get getRuntimeConfig() {
    return getRuntimeConfig;
  },
  get readChannelAllowFromStore() {
    return readChannelAllowFromStore;
  },
  get dispatchReplyWithBufferedBlockDispatcher() {
    return dispatchReplyWithBufferedBlockDispatcher;
  },
  get listSkillCommandsForAgents() {
    return listSkillCommandsForAgents;
  },
  get syncTelegramMenuCommands() {
    return syncTelegramMenuCommands;
  },
  get getPluginCommandSpecs() {
    return getPluginCommandSpecs;
  },
  async editMessageTelegram(...args) {
<<<<<<< HEAD
    const { editMessageTelegram } = await loadTelegramSendModule();
=======
    const { editMessageTelegram } = await loadTelegramSendRuntime();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    return await editMessageTelegram(...args);
  },
};
