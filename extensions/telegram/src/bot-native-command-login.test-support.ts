import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsAuthLoginFlowResult } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
} from "./bot-native-commands.menu-test-support.js";

let loginAccountIndex = 0;

export function createLoginResult(
  profileId: string,
  authRefresh: ModelsAuthLoginFlowResult["authRefresh"] = "refreshed",
): ModelsAuthLoginFlowResult {
  return {
    providerId: "openai",
    methodId: "device-code",
    authRefresh,
    profiles: [{ profileId, provider: "openai", mode: "oauth" }],
  };
}

export function createOwnerLoginConfig(): OpenClawConfig {
  return {
    commands: { native: true, ownerAllowFrom: ["200"] },
    agents: { list: [{ id: "main", default: true }] },
  };
}

export function registerLoginCommand(params: {
  cfg: OpenClawConfig;
  loginFlow: NonNullable<TelegramNativeCommandDeps["runModelsAuthLoginFlow"]>;
  accountId?: string;
  allowFrom?: string[];
  abortSignal?: AbortSignal;
  runtime?: RuntimeEnv;
  getRuntimeConfig?: () => OpenClawConfig;
}) {
  const botHarness = createCommandBot();
  const accountId = params.accountId ?? `login-test-${++loginAccountIndex}`;
  const cfg = {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults: { model: "openai/gpt-5.4", ...params.cfg.agents?.defaults },
    },
  };
  const nativeParams = createNativeCommandTestParams(cfg, {
    accountId,
    bot: botHarness.bot,
    allowFrom: params.allowFrom ?? ["200"],
    ...(params.abortSignal
      ? {
          opts: {
            token: "token",
            accountAbortSignal: params.abortSignal,
          },
        }
      : {}),
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
  const sendMessageTelegram = vi.fn(async (_to, text) => {
    const result = await botHarness.bot.api.sendMessage(100, text, {});
    return { messageId: String(result.message_id), chatId: "100" };
  });
  const nativeCommandCallbackDispatcher = withPluginRuntimeRegistryScope(
    createEmptyPluginRegistry(),
    () =>
      registerTelegramNativeCommands({
        ...nativeParams,
        telegramDeps: {
          ...nativeParams.telegramDeps,
          ...(params.getRuntimeConfig ? { getRuntimeConfig: params.getRuntimeConfig } : {}),
          runModelsAuthLoginFlow: params.loginFlow,
          sendMessageTelegram,
        },
      }),
  );
  const handler = botHarness.commandHandlers.get("login");
  if (!handler) {
    throw new Error("expected login command handler to be registered");
  }
  return {
    ...botHarness,
    accountId,
    handler,
    nativeCommandCallbackDispatcher,
    sendMessageTelegram,
  };
}
