import assert from "node:assert/strict";
import path from "node:path";
import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsAuthLoginFlowResult } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type * as SessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { type Mock, vi } from "vitest";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  nativeCommandMocks,
} from "./bot-native-commands.menu-test-support.js";

export type TelegramLoginFlow =
  typeof import("openclaw/plugin-sdk/provider-auth-login-flow-runtime").runModelsAuthLoginFlow;

let loginAccountIndex = 0;
const defaultModel = "openai/gpt-5.4";

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
