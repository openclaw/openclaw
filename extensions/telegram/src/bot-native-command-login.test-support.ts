import fs from "node:fs/promises";
import path from "node:path";
import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
} from "./bot-native-commands.menu-test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

export type TelegramLoginFlow = NonNullable<TelegramNativeCommandDeps["runModelsAuthLoginFlow"]>;

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
  loginFlow: TelegramLoginFlow;
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

export async function exerciseDeferredModelAccess(choice: "all" | "keep" | "cancel") {
  clearRuntimeConfigSnapshot();
  try {
    await withTempHome(
      async (home) => {
        const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
          await params.prompter.deviceCode?.({ title: "Sign in", code: "MODEL-ACCESS" });
          if (!params.onModelAccessRequested) {
            throw new Error("expected deferred model access");
          }
          params.onModelAccessRequested({
            provider: "openai",
            providerLabel: "OpenAI",
            agentId: "main",
            policy: { path: "agents.defaults.modelPolicy.allow", refs: ["openai/gpt-5.4"] },
            prompt: {
              message: "Credentials saved. Your current model restrictions may hide OpenAI models.",
              initialValue: "keep",
              options: [
                { value: "all", label: "Show all OpenAI models" },
                { value: "keep", label: "Keep current restrictions" },
              ],
            },
          });
          return createLoginResult("openai:consent");
        });
        const cfg: OpenClawConfig = {
          commands: { native: true, ownerAllowFrom: ["200"] },
          agents: {
            defaults: { model: "openai/gpt-5.4", modelPolicy: { allow: ["openai/gpt-5.4"] } },
            entries: { main: { name: "Main" } },
          },
        };
        await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
        const readPolicy = async () => {
          const { snapshot } = await readConfigFileSnapshotForWrite();
          expect(snapshot.valid).toBe(true);
          return snapshot.sourceConfig.agents?.defaults?.modelPolicy?.allow;
        };
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const first = registerLoginCommand({ cfg, loginFlow, runtime });
        await first.handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
        await vi.waitFor(() => expect(deliverReplies).toHaveBeenCalled());
        const delivery = vi.mocked((await import("./bot/delivery.replies.js")).deliverReplies);
        const buttons = delivery.mock.calls
          .at(-1)?.[0]
          .replies[0]?.presentation?.blocks.find((block) => block.type === "buttons");
        expect(buttons).toMatchObject({
          buttons: [
            {
              label: "Show all OpenAI models",
              action: { type: "command", command: expect.stringMatching(/^\/login choice /) },
            },
            {
              label: "Keep current restrictions",
              action: { type: "command", command: expect.stringMatching(/^\/login choice /) },
            },
          ],
        });
        const button = buttons?.buttons[choice === "keep" ? 1 : 0];
        if (button?.action?.type !== "command") {
          throw new Error("expected typed command button");
        }
        const commandText = button.action.command;
        expect(await readPolicy()).toEqual(["openai/gpt-5.4"]);
        const fresh = registerLoginCommand({ cfg, loginFlow, runtime, accountId: first.accountId });
        const dispatch = fresh.nativeCommandCallbackDispatcher;
        if (!dispatch) {
          throw new Error("expected native callback dispatcher");
        }
        let callbackId = 0;
        const click = (chatId: number) =>
          dispatch({
            commandText,
            botUser: telegramBotInfoForTest,
            callbackQuery: {
              id: `model-access-${++callbackId}`,
              chat_instance: "private-chat",
              from: { id: 200, is_bot: false, first_name: "Owner" },
              message: {
                message_id: 101,
                date: 1,
                chat: { id: chatId, type: "private", first_name: "Owner" },
              },
            },
          });
        await click(101);
        expect(await readPolicy()).toEqual(["openai/gpt-5.4"]);
        if (choice === "cancel") {
          await fresh.handler(createPrivateCommandContext({ match: "cancel", userId: 200 }));
          expect(fresh.sendMessage).toHaveBeenLastCalledWith(
            100,
            "Provider login cancelled for this chat.",
            {},
          );
          await click(100);
          expect(fresh.sendMessage).toHaveBeenLastCalledWith(
            100,
            expect.stringContaining("This model access choice is no longer available."),
            {},
          );
          expect(await readPolicy()).toEqual(["openai/gpt-5.4"]);
          expect(loginFlow).toHaveBeenCalledOnce();
          return;
        }
        await click(100);
        expect(await readPolicy()).toEqual(
          choice === "all" ? ["openai/gpt-5.4", "openai/*"] : ["openai/gpt-5.4"],
        );
        expect(fresh.sendMessage).toHaveBeenLastCalledWith(
          100,
          expect.stringContaining(
            choice === "all"
              ? "Application by the running Gateway is not confirmed."
              : "Current model restrictions kept.",
          ),
          {},
        );
        const logsAfterChoice = runtime.log.mock.calls.length;
        await click(100);
        expect(fresh.sendMessage).toHaveBeenLastCalledWith(
          100,
          expect.stringContaining("This model access choice is no longer available."),
          {},
        );
        expect(runtime.log).toHaveBeenCalledTimes(logsAfterChoice);
        expect(loginFlow).toHaveBeenCalledOnce();
      },
      {
        env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") },
      },
    );
  } finally {
    clearRuntimeConfigSnapshot();
  }
}
