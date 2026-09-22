// Native command fixtures register Vitest hooks and must load during test collection.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { vi } from "vitest";
import { registerTelegramNativeCommands } from "./src/bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
  resetNativeCommandMenuMocks,
} from "./src/bot-native-commands.menu-test-support.js";
import { setTelegramRuntime } from "./src/runtime.js";
import { clearTelegramRuntimeForTest } from "./src/runtime.test-support.js";

export function createTelegramNativeCommandTestDriver(options: {
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
  registerTelegramNativeCommands(params);
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
      return native(
        input.group
          ? {
              match: input.match ?? "",
              message: {
                message_id: 17,
                date: 1_700_000_000,
                chat: { id: chatId, type: "supergroup", title: "Owners", is_forum: true },
                message_thread_id: input.threadId,
                from: { id: senderId, username: "admin" },
              },
            }
          : createPrivateCommandContext({
              userId: senderId,
              chatId,
              messageId: 17,
              match: input.match,
            }),
      );
    },
    pairingStoreReadCount: () =>
      vi.mocked(params.telegramDeps.readChannelAllowFromStore).mock.calls.length,
    deliveries: () =>
      deliverReplies.mock.calls.map(([delivery]) => ({ replies: delivery.replies })),
    sentMessages: () =>
      bot.sendMessage.mock.calls.map((call) => {
        const chatId: unknown = call[0];
        const text: unknown = call[1];
        if (
          (typeof chatId !== "number" && typeof chatId !== "string") ||
          typeof text !== "string"
        ) {
          throw new Error("Expected Telegram sendMessage chat ID and text");
        }
        return { chatId, text };
      }),
    configureLogin(input: {
      run: (options: ModelsAuthLoginFlowOptions) => Promise<ModelsAuthLoginFlowResult>;
      onResult: () => void;
    }) {
      params.telegramDeps.runModelsAuthLoginFlow = input.run;
      params.telegramDeps.sendMessageTelegram = async () => {
        input.onResult();
        return { messageId: "999", chatId: "100" };
      };
    },
    close: clearTelegramRuntimeForTest,
  };
}
