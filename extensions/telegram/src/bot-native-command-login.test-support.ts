import fs from "node:fs/promises";
import path from "node:path";
import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import type { ModelsAuthLoginFlowResult } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
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
import { parseTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

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
        const pluginDir = path.join(home, "ux-catalog-fixture");
        await fs.mkdir(pluginDir);
        await Promise.all([
          fs.writeFile(path.join(pluginDir, "index.js"), "export default { register() {} };\n"),
          fs.writeFile(
            path.join(pluginDir, "package.json"),
            JSON.stringify({ type: "module", openclaw: { extensions: ["./index.js"] } }),
          ),
          fs.writeFile(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: "ux-catalog-fixture",
              configSchema: { type: "object", additionalProperties: false, properties: {} },
              providerAuthChoices: [
                {
                  provider: "ux-catalog-fixture",
                  method: "device-code",
                  choiceId: "device",
                  choiceLabel: "Fixture device login",
                  groupLabel: "Fixture",
                  appGuidedAuth: "device-code",
                  credentialOnly: true,
                  channelLogin: {},
                },
                {
                  provider: "ux-catalog-fixture",
                  method: "device-code-alternate",
                  choiceId: "device-alternate",
                  choiceLabel: "Fixture alternate device login",
                  groupLabel: "Fixture",
                  appGuidedAuth: "device-code",
                  credentialOnly: true,
                  channelLogin: {},
                },
              ],
            }),
          ),
        ]);
        const delivery = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
          "./bot/delivery.replies.js",
        );
        deliverReplies.mockImplementation(delivery.deliverReplies);
        const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
          await params.prompter.deviceCode?.({ title: "Sign in", code: "MODEL-ACCESS" });
          if (!params.onModelAccessRequested) {
            throw new Error("expected deferred model access");
          }
          params.onModelAccessRequested({
            provider: "ux-catalog-fixture",
            providerLabel: "Fixture",
            agentId: "main",
            policy: { path: "agents.defaults.modelPolicy.allow", refs: ["openai/gpt-5.4"] },
            prompt: {
              message:
                "Credentials saved. Your current model restrictions may hide Fixture models.",
              initialValue: "keep",
              options: [
                { value: "all", label: "Show all Fixture models" },
                { value: "keep", label: "Keep current restrictions" },
              ],
            },
          });
          return {
            providerId: "ux-catalog-fixture",
            methodId: "device-code",
            authRefresh: "refreshed",
            profiles: [
              {
                profileId: "ux-catalog-fixture:consent",
                provider: "ux-catalog-fixture",
                mode: "oauth",
              },
            ],
          };
        });
        const cfg: OpenClawConfig = {
          commands: { native: true, ownerAllowFrom: ["200"] },
          plugins: {
            load: { paths: [pluginDir] },
            entries: { "ux-catalog-fixture": { enabled: true } },
          },
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
        const deliveredButtons = (calls: Parameters<typeof first.bot.api.sendMessage>[]) =>
          calls.flatMap((call) => {
            const markup = call[2]?.reply_markup;
            return markup && "inline_keyboard" in markup ? markup.inline_keyboard.flat() : [];
          });
        await first.handler(
          createPrivateCommandContext({ match: "ux-catalog-fixture", userId: 200 }),
        );
        const methods = deliveredButtons(vi.mocked(first.bot.api).sendMessage.mock.calls);
        expect(methods).toHaveLength(2);
        expect(methods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              text: "Fixture device login",
              callback_data: "tgcmd:/login ux-catalog-fixture/device",
            }),
            expect.objectContaining({
              text: "Fixture alternate device login",
              callback_data: "tgcmd:/login ux-catalog-fixture/device-alternate",
            }),
          ]),
        );
        expect(loginFlow).not.toHaveBeenCalled();
        first.sendMessage.mockClear();
        deliverReplies.mockClear();
        await first.handler(
          createPrivateCommandContext({ match: "ux-catalog-fixture/device", userId: 200 }),
        );
        await vi.waitFor(() => expect(deliverReplies).toHaveBeenCalledOnce());
        await expect(deliverReplies.mock.results[0]?.value).resolves.toEqual({ delivered: true });
        const buttons = deliveredButtons(vi.mocked(first.bot.api).sendMessage.mock.calls);
        expect(buttons.map((button) => button.text)).toEqual([
          "Show all Fixture models",
          "Keep current restrictions",
        ]);
        const commands = buttons.map((button) => {
          if (!("callback_data" in button)) {
            throw new Error("expected an encoded native command callback");
          }
          expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
          expect(button.callback_data).toContain(" ux-catalog-fixture");
          return parseTelegramNativeCommandCallbackData(button.callback_data);
        });
        const commandText = commands[choice === "keep" ? 1 : 0];
        if (!commandText) {
          throw new Error("expected a delivered model-access command");
        }
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
            "Model-access choice cancelled. Your saved connection is unchanged. Send /models to choose a model.",
            {},
          );
        } else {
          await click(100);
          expect(await readPolicy()).toEqual(
            choice === "all" ? ["openai/gpt-5.4", "ux-catalog-fixture/*"] : ["openai/gpt-5.4"],
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
        }
        const deliveriesBeforeRecovery = deliverReplies.mock.calls.length;
        const sendsBeforeRecovery = fresh.sendMessage.mock.calls.length;
        await click(100);
        expect(await readPolicy()).toEqual(
          choice === "all" ? ["openai/gpt-5.4", "ux-catalog-fixture/*"] : ["openai/gpt-5.4"],
        );
        expect(deliverReplies.mock.calls).toHaveLength(deliveriesBeforeRecovery + 1);
        const recoveryMessages = vi
          .mocked(fresh.bot.api)
          .sendMessage.mock.calls.slice(sendsBeforeRecovery);
        expect(recoveryMessages.map(([, text]) => text).join("\n")).toContain(
          "Choose model access using your current restrictions. You do not need to sign in again.",
        );
        const renewedButtons = deliveredButtons(recoveryMessages);
        expect(renewedButtons.map((button) => button.text)).toEqual([
          "Show all Fixture models",
          "Keep current restrictions",
        ]);
        for (const button of renewedButtons) {
          if (!("callback_data" in button)) {
            throw new Error("expected a renewed native command callback");
          }
          expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
          const renewedCommand = parseTelegramNativeCommandCallbackData(button.callback_data);
          expect(renewedCommand).toMatch(/^\/login choice [a-f0-9]+ [01] ux-catalog-fixture$/u);
          expect(commands).not.toContain(renewedCommand);
        }
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
