import assert from "node:assert/strict";
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
import type * as SessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, type Mock, vi } from "vitest";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
  nativeCommandMocks,
} from "./bot-native-commands.menu-test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { parseTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

export type TelegramLoginFlow =
  typeof import("openclaw/plugin-sdk/provider-auth-login-flow-runtime").runModelsAuthLoginFlow;

let loginAccountIndex = 0;
const fixtureId = "ux-catalog-fixture";
const defaultModel = "openai/gpt-5.4";
const modelButtons = ["Show all Fixture models", "Keep current restrictions"];
const methodChoices = ["", "-alternate"].map((suffix) => ({
  method: `device-code${suffix}`,
  choiceId: `device${suffix}`,
  choiceLabel: suffix ? "Fixture alternate device login" : "Fixture device login",
  provider: fixtureId,
  groupLabel: "Fixture",
  appGuidedAuth: "device-code",
  credentialOnly: true,
  channelLogin: {},
}));

export function createLoginResult(
  profileId: string,
  authRefresh: ModelsAuthLoginFlowResult["authRefresh"] = "refreshed",
  provider = "openai",
): ModelsAuthLoginFlowResult {
  return {
    providerId: provider,
    methodId: "device-code",
    authRefresh,
    profiles: [{ profileId, provider, mode: "oauth" }],
  };
}

export function createOwnerLoginConfig(): OpenClawConfig {
  return { commands: { native: true, ownerAllowFrom: ["200"] }, agents: { entries: { main: {} } } };
}

export async function prepareTelegramLoginSessionStore(
  directory: string,
  mocks: {
    getSessionEntry: Mock<typeof SessionStore.getSessionEntryAsync>;
    resolveStorePath: ReturnType<typeof vi.fn>;
    prepareSessionEntryPatch: Mock<typeof SessionStore.prepareSessionEntryPatch>;
  },
) {
  const store = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  const storePath = path.join(directory, "sessions.sqlite");
  const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
  await store.upsertSessionEntry({
    ...scope,
    entry: { sessionId: "telegram-login", updatedAt: 1, authProfileOverride: "openai:prior" },
  });
  mocks.getSessionEntry.mockImplementation((requested) =>
    store.getSessionEntryAsync({ ...requested, storePath: scope.storePath }),
  );
  mocks.resolveStorePath.mockReturnValue(scope.storePath);
  mocks.prepareSessionEntryPatch.mockImplementation(store.prepareSessionEntryPatch);
  return { store, scope };
}

export async function registerLoginCommand(params: {
  cfg: OpenClawConfig;
  loginFlow: TelegramLoginFlow;
  accountId?: string;
  allowFrom?: string[];
  abortSignal?: AbortSignal;
  runtime?: RuntimeEnv;
  getRuntimeConfig?: () => OpenClawConfig;
}) {
  const fixture = createCommandBot();
  const accountId = params.accountId ?? `login-test-${++loginAccountIndex}`;
  const agents = params.cfg.agents;
  const cfg = {
    ...params.cfg,
    agents: { ...agents, defaults: { model: defaultModel, ...agents?.defaults } },
  };
  const signal = params.abortSignal;
  const nativeParams = createNativeCommandTestParams(cfg, {
    accountId,
    bot: fixture.bot,
    allowFrom: params.allowFrom ?? ["200"],
    ...(signal ? { opts: { token: "token", accountAbortSignal: signal } } : {}),
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
  const sendMessageTelegram = vi.fn<typeof import("./send.js").sendMessageTelegram>(
    async (_to, text) => {
      const result = await fixture.bot.api.sendMessage(100, text, {});
      return { messageId: String(result.message_id), chatId: "100" };
    },
  );
  if (params.getRuntimeConfig) {
    nativeCommandMocks.getRuntimeConfig.mockImplementation(params.getRuntimeConfig);
  }
  nativeCommandMocks.runModelsAuthLoginFlow.mockImplementation(params.loginFlow);
  nativeCommandMocks.sendMessageTelegram.mockImplementation(sendMessageTelegram);
  const { nativeCommandCallbackDispatcher } = await withPluginRuntimeRegistryScope(
    createEmptyPluginRegistry(),
    () => registerTelegramNativeCommands(nativeParams),
  );
  const handler = fixture.commandHandlers.get("login");
  assert(handler, "expected login command handler to be registered");
  return { ...fixture, accountId, handler, nativeCommandCallbackDispatcher, sendMessageTelegram };
}

export async function exerciseDeferredModelAccess(choice: "all" | "cancel") {
  clearRuntimeConfigSnapshot();
  try {
    await withTempHome((home) => exerciseModelAccess(home, choice), {
      env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") },
    });
  } finally {
    clearRuntimeConfigSnapshot();
  }
}

async function exerciseModelAccess(home: string, choice: "all" | "cancel") {
  const pluginDir = path.join(home, fixtureId);
  await fs.mkdir(pluginDir);
  const writeJson = (file: string, data: unknown) =>
    fs.writeFile(path.join(pluginDir, file), JSON.stringify(data));
  await Promise.all([
    fs.writeFile(path.join(pluginDir, "index.js"), "export default { register() {} };\n"),
    writeJson("package.json", { type: "module", openclaw: { extensions: ["./index.js"] } }),
    writeJson("openclaw.plugin.json", {
      id: fixtureId,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      providerAuthChoices: methodChoices,
    }),
  ]);
  const delivery = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
    "./bot/delivery.replies.js",
  );
  deliverReplies.mockImplementation(delivery.deliverReplies);
  const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
    await params.prompter.deviceCode?.({ title: "Sign in", code: "MODEL-ACCESS" });
    assert(params.onModelAccessRequested, "expected deferred model access");
    params.onModelAccessRequested({
      provider: fixtureId,
      providerLabel: "Fixture",
      agentId: "main",
      policy: { path: "agents.defaults.modelPolicy.allow", refs: [defaultModel] },
      prompt: {
        message: "Credentials saved. Your current model restrictions may hide Fixture models.",
        initialValue: "keep",
        options: [
          { value: "all", label: "Show all Fixture models" },
          { value: "keep", label: "Keep current restrictions" },
        ],
      },
    });
    return createLoginResult("ux-catalog-fixture:consent", "refreshed", fixtureId);
  });
  const cfg: OpenClawConfig = {
    commands: { native: true, ownerAllowFrom: ["200"] },
    plugins: {
      load: { paths: [pluginDir] },
      entries: { [fixtureId]: { enabled: true } },
    },
    agents: {
      defaults: { model: defaultModel, modelPolicy: { allow: [defaultModel] } },
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
  const first = await registerLoginCommand({ cfg, loginFlow, runtime });
  const deliveredButtons = (calls: typeof first.sendMessage.mock.calls) =>
    calls.flatMap((call) => {
      const markup = call[2]?.reply_markup;
      return markup && "inline_keyboard" in markup ? markup.inline_keyboard.flat() : [];
    });
  await first.handler(createPrivateCommandContext({ match: `${fixtureId}/device`, userId: 200 }));
  await vi.waitFor(() => expect(deliverReplies).toHaveBeenCalledOnce());
  await expect(deliverReplies.mock.results[0]?.value).resolves.toMatchObject({ delivered: true });
  const buttons = deliveredButtons(first.sendMessage.mock.calls);
  expect(buttons.map((button) => button.text)).toEqual(modelButtons);
  const decodeButton = (button: (typeof buttons)[number]) => {
    assert("callback_data" in button, "expected a native command callback");
    expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
    expect(button.callback_data).toContain(" ux-catalog-fixture");
    return parseTelegramNativeCommandCallbackData(button.callback_data);
  };
  const commands = buttons.map(decodeButton);
  const commandText = commands[0];
  assert(commandText, "expected a delivered model-access command");
  expect(await readPolicy()).toEqual([defaultModel]);
  const fresh = await registerLoginCommand({ cfg, loginFlow, runtime, accountId: first.accountId });
  const dispatch = fresh.nativeCommandCallbackDispatcher;
  assert(dispatch, "expected native callback dispatcher");
  const expectedModels = choice === "all" ? [defaultModel, `${fixtureId}/*`] : [defaultModel];
  let callbackId = 0;
  const click = (id: number) =>
    dispatch({
      commandText,
      botUser: telegramBotInfoForTest,
      callbackQuery: {
        id: `model-access-${++callbackId}`,
        chat_instance: "private-chat",
        from: { id: 200, is_bot: false, first_name: "Owner" },
        message: { message_id: 101, date: 1, chat: { id, type: "private", first_name: "Owner" } },
      },
    });
  await click(101);
  expect(await readPolicy()).toEqual([defaultModel]);
  if (choice === "cancel") {
    await fresh.handler(createPrivateCommandContext({ match: "cancel", userId: 200 }));
    expect(fresh.sendMessage).toHaveBeenLastCalledWith(
      100,
      "Model-access choice cancelled. Your saved connection is unchanged. Send /models to choose a model.",
      {},
    );
  } else {
    await click(100);
    expect(await readPolicy()).toEqual(expectedModels);
    expect(fresh.sendMessage).toHaveBeenLastCalledWith(
      100,
      expect.stringContaining("Application by the running Gateway is not confirmed."),
      {},
    );
  }
  const deliveriesBeforeRecovery = deliverReplies.mock.calls.length;
  const sendsBeforeRecovery = fresh.sendMessage.mock.calls.length;
  await click(100);
  expect(await readPolicy()).toEqual(expectedModels);
  expect(deliverReplies.mock.calls).toHaveLength(deliveriesBeforeRecovery + 1);
  const recoveryMessages = fresh.sendMessage.mock.calls.slice(sendsBeforeRecovery);
  expect(recoveryMessages.map(([, text]) => text).join("\n")).toContain(
    "Choose model access using your current restrictions. You do not need to sign in again.",
  );
  const renewedButtons = deliveredButtons(recoveryMessages);
  expect(renewedButtons.map((button) => button.text)).toEqual(modelButtons);
  for (const button of renewedButtons) {
    const renewedCommand = decodeButton(button);
    expect(renewedCommand).toMatch(/^\/login choice [a-f0-9]+ [01] ux-catalog-fixture$/u);
    expect(commands).not.toContain(renewedCommand);
  }
  expect(loginFlow).toHaveBeenCalledOnce();
}
