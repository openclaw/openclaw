// Native command fixtures register Vitest hooks and must load during test collection.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { registerTelegramNativeCommands } from "./src/bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
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
      const command = input.command ?? "qaowner";
      const native = bot.commandHandlers.get(command);
      if (!native) {
        throw new Error(`Expected registered native /${command} command`);
      }
      const senderId = input.senderId ?? 100;
      const chatId = input.chatId ?? senderId;
      const context = createPrivateCommandContext({
        userId: senderId,
        chatId,
        messageId: 17,
        match: input.match,
        ...(input.group ? { date: 1_700_000_000, username: "admin" } : {}),
      });
      return native(
        input.group
          ? {
              ...context,
              message: {
                ...context.message,
                chat: { id: chatId, type: "supergroup", title: "Owners", is_forum: true },
                message_thread_id: input.threadId,
              },
            }
          : context,
      );
    },
    pairingStoreReadCount: () => nativeCommandMocks.readChannelAllowFromStore.mock.calls.length,
    deliveries: () =>
      deliverReplies.mock.calls.map(([delivery]) => ({ replies: delivery.replies })),
    sentMessages: () =>
      bot.sendMessage.mock.calls.map(([chatId, text]: unknown[]) => {
        if (
          (typeof chatId !== "number" && typeof chatId !== "string") ||
          typeof text !== "string"
        ) {
          throw new Error("Expected Telegram sendMessage chat ID and text");
        }
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
