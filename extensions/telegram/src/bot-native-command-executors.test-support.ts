import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-dispatch-runtime";
// Telegram tests cover bot native commands.session meta plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import { createConfiguredBindingRoute } from "./bot-native-command-dispatch.test-support.js";
import {
  createNativeCommandTestParams,
  createTelegramPrivateCommandContext,
  type NativeCommandTestParams,
} from "./bot-native-commands.fixture-test-support.js";

// Shared executor test harness; each importing suite resets the state before use.

type ResolveConfiguredBindingRouteFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").resolveConfiguredBindingRoute;
type EnsureConfiguredBindingRouteReadyFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").ensureConfiguredBindingRouteReady;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type ResolveCommandArgMenuFn =
  typeof import("openclaw/plugin-sdk/command-auth-native").resolveCommandArgMenu;
type DeliverRepliesFn = typeof import("./bot/delivery.js").deliverReplies;
type LoadModelCatalogFn = typeof import("openclaw/plugin-sdk/agent-runtime").loadModelCatalog;
type ResolveDefaultModelForAgentFn =
  typeof import("openclaw/plugin-sdk/agent-runtime").resolveDefaultModelForAgent;

const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
  queuedFinal: false,
  counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
};

const persistentBindingMocks = vi.hoisted(() => ({
  resolveConfiguredBindingRoute: vi.fn<ResolveConfiguredBindingRouteFn>(({ route }) => ({
    bindingResolution: null,
    route,
  })),
  ensureConfiguredBindingRouteReady: vi.fn<EnsureConfiguredBindingRouteReadyFn>(async () => ({
    ok: true,
  })),
}));
const sessionMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  sessionStoreEntries: vi.fn(),
  resolveStorePath: vi.fn(),
}));
const commandAuthMocks = vi.hoisted(() => ({
  resolveCommandArgMenu: vi.fn<ResolveCommandArgMenuFn>(),
}));
const agentRuntimeMocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn<LoadModelCatalogFn>(async () => [
    {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: true,
    },
  ]),
  resolveDefaultModelForAgent: vi.fn<ResolveDefaultModelForAgentFn>(),
}));
const pluginRuntimeMocks = vi.hoisted(() => ({
  executePluginCommand: vi.fn(async (_params?: unknown) => ({ text: "ok" })),
}));
const replyMocks = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async () => dispatchReplyResult,
  ),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn<DeliverRepliesFn>(async () => ({ delivered: true })),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn<
    (ref: unknown) => { bindingId: string; targetSessionKey: string } | null
  >(() => null),
  touch: vi.fn(),
}));
const conversationStoreMocks = vi.hoisted(() => ({
  readChannelAllowFromStore: vi.fn(async () => []),
  upsertChannelPairingRequest: vi.fn(async () => ({ code: "PAIRCODE", created: true })),
}));

export const executorTestMocks = {
  agentRuntimeMocks,
  commandAuthMocks,
  conversationStoreMocks,
  deliveryMocks,
  persistentBindingMocks,
  pluginRuntimeMocks,
  replyMocks,
  sessionBindingMocks,
  sessionMocks,
};

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: persistentBindingMocks.resolveConfiguredBindingRoute,
    resolveRuntimeConversationBindingRoute: (
      params: Parameters<typeof actual.resolveRuntimeConversationBindingRoute>[0],
    ) => {
      const conversation =
        "conversation" in params
          ? params.conversation
          : {
              channel: params.channel,
              accountId: params.accountId,
              conversationId: params.conversationId,
              parentConversationId: params.parentConversationId,
            };
      const bindingRecord = sessionBindingMocks.resolveByConversation(conversation);
      const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
      if (!bindingRecord || !boundSessionKey) {
        return { bindingRecord: null, route: params.route };
      }
      sessionBindingMocks.touch(bindingRecord.bindingId, undefined);
      return {
        bindingRecord,
        boundSessionKey,
        boundAgentId: params.route.agentId,
        route: {
          ...params.route,
          sessionKey: boundSessionKey,
          lastRoutePolicy: boundSessionKey === params.route.mainSessionKey ? "main" : "session",
          matchedBy: "binding.channel",
        },
      };
    },
    ensureConfiguredBindingRouteReady: persistentBindingMocks.ensureConfiguredBindingRouteReady,
    readChannelAllowFromStore: conversationStoreMocks.readChannelAllowFromStore,
    upsertChannelPairingRequest: conversationStoreMocks.upsertChannelPairingRequest,
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => sessionBindingMocks.resolveByConversation(ref),
      touch: (bindingId: string, at?: number) => sessionBindingMocks.touch(bindingId, at),
      unbind: vi.fn(),
    }),
  };
});
vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntry: sessionMocks.getSessionEntry,
    sessionStoreEntries: sessionMocks.sessionStoreEntries,
    resolveStorePath: sessionMocks.resolveStorePath,
  };
});
vi.mock("openclaw/plugin-sdk/command-auth-native", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/command-auth-native")>(
    "openclaw/plugin-sdk/command-auth-native",
  );
  commandAuthMocks.resolveCommandArgMenu.mockImplementation(actual.resolveCommandArgMenu);
  return {
    ...actual,
    resolveCommandArgMenu: commandAuthMocks.resolveCommandArgMenu,
  };
});
vi.mock("openclaw/plugin-sdk/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-runtime")>(
    "openclaw/plugin-sdk/agent-runtime",
  );
  agentRuntimeMocks.resolveDefaultModelForAgent.mockImplementation(
    actual.resolveDefaultModelForAgent,
  );
  return {
    ...actual,
    loadPreparedModelCatalog: agentRuntimeMocks.loadModelCatalog,
    resolveDefaultModelForAgent: agentRuntimeMocks.resolveDefaultModelForAgent,
  };
});
vi.mock("./bot-native-commands.runtime.js", () => {
  return {
    ensureConfiguredBindingRouteReady: persistentBindingMocks.ensureConfiguredBindingRouteReady,
    getAgentScopedMediaLocalRoots,
    getSessionEntry: sessionMocks.getSessionEntry,
    resolveChunkMode,
  };
});
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));
vi.mock("./bot/delivery.replies.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

let activePluginRegistry: ReturnType<typeof createEmptyPluginRegistry>;

type TelegramCommandHandler = (ctx: unknown, next?: () => Promise<void>) => Promise<void>;
type TelegramPluginCommandSpecs = Array<{
  name: string;
  description: string;
  acceptsArgs?: boolean;
}>;
type TelegramLoginFlow = NonNullable<TelegramNativeCommandDeps["runModelsAuthLoginFlow"]>;

function registerAndResolveCommandHandlerBase(params: {
  commandName: string;
  cfg: OpenClawConfig;
  runtimeCfg?: OpenClawConfig;
  allowFrom: string[];
  groupAllowFrom: string[];
  storeAllowFrom?: string[];
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
  pluginCommandSpecs?: TelegramPluginCommandSpecs;
  runModelsAuthLoginFlow?: TelegramLoginFlow;
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    runtimeCfg,
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
    telegramCfg,
    resolveTelegramGroupConfig,
    pluginCommandSpecs,
    runModelsAuthLoginFlow,
  } = params;
  const commandHandlers = new Map<string, TelegramCommandHandler>();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const baseRuntimeCfg = runtimeCfg ?? cfg;
  const commandRuntimeCfg = baseRuntimeCfg;
  const telegramDeps: TelegramNativeCommandDeps = {
    getRuntimeConfig: vi.fn(() => commandRuntimeCfg),
    readChannelAllowFromStore: vi.fn(async () => storeAllowFrom ?? []),
    listSkillCommandsForAgents: vi.fn(() => []),
    syncTelegramMenuCommands: vi.fn(),
    sendMessageTelegram: vi.fn(async (_to, text) => {
      await sendMessage(100, text, {});
      return { messageId: "999", chatId: "100" };
    }),
    ...(runModelsAuthLoginFlow ? { runModelsAuthLoginFlow } : {}),
  };
  withPluginRuntimeRegistryScope(activePluginRegistry, () => {
    for (const spec of pluginCommandSpecs ?? []) {
      expect(
        registerPluginCommand(`test-${spec.name}`, {
          ...spec,
          requireAuth: true,
          handler: pluginRuntimeMocks.executePluginCommand,
        }),
      ).toEqual({ ok: true });
    }
    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({
        bot: {
          api: {
            setMyCommands: vi.fn().mockResolvedValue(undefined),
            sendMessage,
          },
          command: vi.fn((name: string, cb: TelegramCommandHandler) => {
            commandHandlers.set(name, cb);
          }),
        } as unknown as NativeCommandTestParams["bot"],
        cfg,
        opts: { token: "token" },
        allowFrom,
        groupAllowFrom,
        telegramCfg,
        resolveTelegramGroupConfig,
        telegramDeps,
      }),
    });
  });

  const handler = commandHandlers.get(commandName);
  if (!handler) {
    throw new Error(`expected ${commandName} command handler to be registered`);
  }
  return { handler, sendMessage };
}

export function registerAndResolveCommandHandler(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  storeAllowFrom?: string[];
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
  pluginCommandSpecs?: TelegramPluginCommandSpecs;
  runModelsAuthLoginFlow?: TelegramLoginFlow;
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
    telegramCfg,
    resolveTelegramGroupConfig,
    pluginCommandSpecs,
    runModelsAuthLoginFlow,
  } = params;
  return registerAndResolveCommandHandlerBase({
    commandName,
    cfg,
    allowFrom: allowFrom ?? [],
    groupAllowFrom: groupAllowFrom ?? [],
    storeAllowFrom,
    telegramCfg,
    resolveTelegramGroupConfig,
    pluginCommandSpecs,
    runModelsAuthLoginFlow,
  });
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

const requireRecord = createRequireRecord("record", "expected-label-object");

export function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

export function expectSendMessageCall(params: {
  sendMessage: ReturnType<typeof vi.fn>;
  callIndex?: number;
  chatId: unknown;
  text?: string;
  textIncludes?: string;
  optionFields?: Record<string, unknown>;
  requireReplyMarkup?: boolean;
  label: string;
}): Record<string, unknown> {
  const call = requireValue(
    params.sendMessage.mock.calls[params.callIndex ?? 0],
    `${params.label} sendMessage call`,
  );
  expect(call[0]).toBe(params.chatId);
  if (params.text !== undefined) {
    expect(call[1]).toBe(params.text);
  }
  if (params.textIncludes !== undefined) {
    expect(String(call[1])).toContain(params.textIncludes);
  }
  const options = params.optionFields
    ? expectRecordFields(call[2], params.optionFields, `${params.label} sendMessage options`)
    : requireRecord(call[2], `${params.label} sendMessage options`);
  if (params.requireReplyMarkup) {
    requireRecord(options.reply_markup, `${params.label} reply markup`);
  }
  return options;
}

export function resetSessionMetaMocks() {
  persistentBindingMocks.resolveConfiguredBindingRoute.mockClear();
  persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
    createConfiguredBindingRoute(route, null),
  );
  persistentBindingMocks.ensureConfiguredBindingRouteReady.mockClear();
  persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({ ok: true });
  commandAuthMocks.resolveCommandArgMenu.mockClear().mockImplementation(({ command, args }) => {
    if (args?.raw || (args?.values && Object.keys(args.values).length > 0)) {
      return null;
    }
    const arg = command.args?.[0];
    if (!arg) {
      return null;
    }
    if (command.key === "think") {
      return {
        arg,
        choices: ["low", "medium", "high"].map((value) => ({ label: value, value })),
      };
    }
    if (command.key === "fast") {
      const choices = ["on", "off", "auto (30 sec)", "default", "status"];
      return {
        arg,
        choices: choices.map((value) => ({ label: value, value })),
      };
    }
    return null;
  });
  agentRuntimeMocks.loadModelCatalog.mockClear().mockResolvedValue([
    {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: true,
    },
  ]);
  sessionMocks.getSessionEntry.mockClear().mockReturnValue(undefined);
  sessionMocks.sessionStoreEntries.mockClear().mockReturnValue({});
  sessionMocks.getSessionEntry.mockImplementation(
    ({ storePath, sessionKey }: { storePath: string; sessionKey: string }) =>
      sessionMocks.sessionStoreEntries(storePath)[sessionKey],
  );
  sessionMocks.resolveStorePath.mockClear().mockReturnValue("/tmp/openclaw-sessions.json");
  pluginRuntimeMocks.executePluginCommand.mockClear().mockResolvedValue({ text: "ok" });
  activePluginRegistry = createEmptyPluginRegistry();
  replyMocks.dispatchReplyWithBufferedBlockDispatcher
    .mockClear()
    .mockResolvedValue(dispatchReplyResult);
  sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
  sessionBindingMocks.touch.mockReset();
  deliveryMocks.deliverReplies.mockClear().mockResolvedValue({ delivered: true });
}

activePluginRegistry = createEmptyPluginRegistry();
const { registerTelegramNativeCommands } = await import("./bot-native-commands.js");
resetSessionMetaMocks();
const warmHandler = registerAndResolveCommandHandler({ commandName: "think", cfg: {} });
await warmHandler.handler(createTelegramPrivateCommandContext({ match: "high" }), async () => {});
