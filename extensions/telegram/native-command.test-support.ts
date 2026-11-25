import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { registerTelegramNativeCommands } from "./src/bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  deliverReplies,
  nativeCommandMocks,
  resetNativeCommandMenuMocks,
} from "./src/bot-native-commands.menu-test-support.js";
import { setTelegramRuntime } from "./src/runtime.js";
import { clearTelegramRuntimeForTest } from "./src/runtime.test-support.js";

export async function createTelegramNativeCommandTestDriver(options: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
}) {
  resetNativeCommandMenuMocks();
  const bot = createCommandBot();
  const params = createNativeCommandTestParams(options.cfg, {
    bot: bot.bot,
    resolveTelegramGroupConfig: (chatId, threadId, config) => {
      const groupConfig = config.channels?.telegram?.groups?.[String(chatId)];
      return {
        groupConfig,
        topicConfig: threadId === undefined ? undefined : groupConfig?.topics?.[String(threadId)],
      };
    },
  });
  setTelegramRuntime(options.runtime);
  await registerTelegramNativeCommands(params);
  return {
    invoke(
      input: {
        command?: string;
        senderId?: number;
        chatId?: number;
        group?: boolean;
        threadId?: number;
        match?: string;
      } = {},
    ) {
      const native = bot.commandHandlers.get(input.command ?? "qaowner");
      assert(native, "Expected registered native command");
      const { senderId = 100, chatId = senderId } = input;
      return native({
        match: input.match ?? "",
        message: {
          message_id: 17,
          date: input.group ? 1_700_000_000 : Math.floor(Date.now() / 1000),
          chat: {
            id: chatId,
            type: input.group ? "supergroup" : "private",
            ...(input.group ? { title: "Owners", is_forum: true } : {}),
          },
          ...(input.group ? { message_thread_id: input.threadId } : {}),
          from: { id: senderId, username: input.group ? "admin" : "bob" },
        },
      });
    },
    pairingStoreReadCount: () => nativeCommandMocks.readChannelAllowFromStore.mock.calls.length,
    deliveries: () => deliverReplies.mock.calls.map(([{ replies }]) => ({ replies })),
    sentMessages: () =>
      bot.sendMessage.mock.calls.map(([chatId, text]: unknown[]) => {
        assert(typeof chatId === "number" || typeof chatId === "string");
        assert(typeof text === "string");
        return { chatId, text };
      }),
    configureLogin(input: {
      run: Parameters<typeof nativeCommandMocks.runModelsAuthLoginFlow.mockImplementation>[0];
      onResult: () => void;
    }) {
      nativeCommandMocks.runModelsAuthLoginFlow.mockImplementation(input.run);
      nativeCommandMocks.sendMessageTelegram.mockImplementation(async () => {
        input.onResult();
        return { messageId: "999", chatId: "100" };
      });
    },
    close: clearTelegramRuntimeForTest,
  };
}
