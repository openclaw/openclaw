import { EventEmitter } from "node:events";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { type Mock, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";

type NativeCommandSpecMock = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

function baseDiscordAccountConfig() {
  return {
    commands: { native: true, nativeSkills: false },
    voice: { enabled: false },
    agentComponents: { enabled: false },
    execApprovals: { enabled: false },
  };
}

const { mocks: providerMonitorTestMocks, resetMocks } = vi.hoisted(() => {
  const createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const resets: Array<() => void> = [];
  function resettable<T extends (...args: never[]) => unknown>(implementation: T): Mock<T> {
    const mock = vi.fn(implementation);
    resets.push(() => {
      mock.mockClear().mockImplementation(implementation);
    });
    return mock;
  }

  const mocks = {
    clientDeployCommandsMock: resettable(async () => undefined),
    clientFetchUserMock: resettable(async (_target: string) => ({ id: "bot-1" })),
    clientGetPluginMock: resettable<(_name: string) => unknown>(() => undefined),
    clientConstructorOptionsMock: vi.fn<(options?: unknown) => void>(),
    createDiscordAutoPresenceControllerMock: resettable<() => unknown>(() => ({
      enabled: false,
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(),
    })),
    createDiscordExecApprovalButtonContextMock: resettable<
      (params?: {
        cfg?: OpenClawConfig;
        accountId?: string;
        config?: unknown;
        gatewayUrl?: string;
      }) => {
        getApprovers: () => string[];
        resolveApproval: () => Promise<boolean>;
      }
    >(() => ({
      getApprovers: () => [],
      resolveApproval: async () => false,
    })),
    createExecApprovalButtonMock: resettable<(ctx?: unknown) => unknown>(() => ({
      id: "exec-approval",
    })),
    createDiscordNativeCommandMock: resettable<
      (params?: { command?: { name?: string } }) => unknown
    >((params) => ({
      name: params?.command?.name ?? "mock-command",
    })),
    createDiscordMessageHandlerMock: resettable<() => unknown>(() =>
      Object.assign(
        vi.fn(async () => undefined),
        { deactivate: vi.fn(async () => {}) },
      ),
    ),
    createNoopThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    createThreadBindingManagerMock: vi.fn<
      () => { stop: ReturnType<typeof vi.fn> } | Promise<{ stop: ReturnType<typeof vi.fn> }>
    >(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    reconcileAcpThreadBindingsOnStartupMock: resettable<() => unknown>(() => ({
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    })),
    createdBindingManagers,
    getAcpSessionStatusMock: resettable(
      async (_params: { cfg: OpenClawConfig; sessionKey: string; signal?: AbortSignal }) => ({
        state: "idle",
      }),
    ),
    listNativeCommandSpecsForConfigMock: resettable<
      (
        cfg?: unknown,
        params?: { skillCommands?: unknown[]; provider?: string },
      ) => NativeCommandSpecMock[]
    >(() => [{ name: "cmd", description: "built-in", acceptsArgs: false }]),
    prepareSkillCommandsForAgentsMock: resettable<
      (params?: { cfg?: unknown; agentIds?: string[] }) => Promise<unknown[]>
    >(async () => []),
    monitorLifecycleMock: resettable(async (params: { threadBindings: { stop: () => void } }) => {
      params.threadBindings.stop();
    }),
    resolveDiscordAccountMock: resettable<
      (params?: { cfg?: unknown; accountId?: string | null; token?: string | null }) => unknown
    >((_params) => ({
      accountId: "default",
      token: "cfg-token",
      config: baseDiscordAccountConfig(),
    })),
    resolveDiscordAllowlistConfigMock: resettable<() => Promise<unknown>>(async () => ({
      guildEntries: undefined,
      allowFrom: undefined,
    })),
    isNativeCommandsExplicitlyDisabledMock: resettable((_params?: unknown) => false),
    resolveNativeCommandsEnabledMock: resettable((_params?: unknown) => true),
    resolveNativeSkillsEnabledMock: resettable((_params?: unknown) => false),
    shouldLogVerboseMock: resettable(() => false),
    voiceRuntimeModuleLoadedMock: vi.fn<() => void>(),
  };
  return { mocks, resetMocks: () => resets.forEach((reset) => reset()) };
});

const {
  clientDeployCommandsMock,
  clientFetchUserMock,
  clientGetPluginMock,
  clientConstructorOptionsMock,
  createDiscordAutoPresenceControllerMock,
  createDiscordExecApprovalButtonContextMock,
  createExecApprovalButtonMock,
  createDiscordNativeCommandMock,
  createDiscordMessageHandlerMock,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartupMock,
  createdBindingManagers,
  getAcpSessionStatusMock,
  listNativeCommandSpecsForConfigMock,
  prepareSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  resolveDiscordAccountMock,
  resolveDiscordAllowlistConfigMock,
  isNativeCommandsExplicitlyDisabledMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  shouldLogVerboseMock,
  voiceRuntimeModuleLoadedMock,
} = providerMonitorTestMocks;

export function getProviderMonitorTestMocks(): typeof providerMonitorTestMocks {
  return providerMonitorTestMocks;
}

export function resetDiscordProviderMonitorMocks() {
  resetMocks();
  clientConstructorOptionsMock.mockClear();
  createNoopThreadBindingManagerMock.mockClear();
  createThreadBindingManagerMock.mockClear();
  createdBindingManagers.length = 0;
  voiceRuntimeModuleLoadedMock.mockClear();
}

export const baseRuntime = (): RuntimeEnv => createRuntimeSpies();

export const baseConfig = (): OpenClawConfig => ({
  channels: { discord: { accounts: { default: { token: "MTIz.abc.def" } } } },
});

vi.mock("../internal/discord.js", async () => {
  const actual =
    await vi.importActual<typeof import("../internal/discord.js")>("../internal/discord.js");
  class Client {
    listeners: unknown[];
    plugins: NonNullable<ConstructorParameters<typeof actual.Client>[2]>;
    rest = {
      options: { timeout: 15_000 },
      get: vi.fn(async () => undefined),
      post: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    options: unknown;
    constructor(
      options: unknown,
      handlers: { listeners?: unknown[] },
      plugins: ConstructorParameters<typeof actual.Client>[2] = [],
    ) {
      this.options = options;
      this.listeners = handlers.listeners ?? [];
      this.plugins = [...plugins];
      clientConstructorOptionsMock(options);
    }
    async deployCommands() {
      return await clientDeployCommandsMock();
    }
    async fetchUser(target: string) {
      return await clientFetchUserMock(target);
    }
    getPlugin(name: string) {
      return clientGetPluginMock(name) ?? this.plugins.find((plugin) => plugin.id === name);
    }
  }
  return { ...actual, Client };
});

vi.mock("../internal/gateway.js", () => ({
  GatewayCloseCodes: { DisallowedIntents: 4014 },
}));

vi.mock("../internal/voice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../internal/voice.js")>()),
  VoicePlugin: class {
    id = "voice";
    registerClient() {}
  },
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  getAcpSessionManager: () => ({
    getSessionStatus: getAcpSessionStatusMock,
  }),
  isAcpRuntimeError: (error: unknown): error is { code: string } =>
    error instanceof Error && "code" in error,
}));

vi.mock("openclaw/plugin-sdk/command-auth-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/command-auth-native")>()),
  listNativeCommandSpecsForConfig: listNativeCommandSpecsForConfigMock,
  prepareSkillCommandsForAgents: prepareSkillCommandsForAgentsMock,
}));
vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>()),
  resolveTextChunkLimit: () => 2000,
}));

vi.mock("openclaw/plugin-sdk/native-command-config-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/native-command-config-runtime")>()),
  isNativeCommandsExplicitlyDisabled: isNativeCommandsExplicitlyDisabledMock,
  resolveNativeCommandsEnabled: resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabled: resolveNativeSkillsEnabledMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  danger: (value: string) => value,
  isVerbose: () => false,
  logVerbose: vi.fn(),
  shouldLogVerbose: shouldLogVerboseMock,
  warn: (value: string) => value,
  createSubsystemLogger: () => {
    const logger = {
      child: vi.fn(() => logger),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    return logger;
  },
  createNonExitingRuntime: () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }),
}));

vi.mock("openclaw/plugin-sdk/error-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/error-runtime")>()),
  formatErrorMessage: (error: unknown) => String(error),
}));

vi.mock("../accounts.js", () => ({
  resolveDiscordAccount: resolveDiscordAccountMock,
  resolveDiscordAccountAllowFrom: () => undefined,
  resolveDiscordAccountDmPolicy: () => undefined,
}));

vi.mock("../probe.js", () => ({
  fetchDiscordApplicationId: async () => "app-1",
  probeDiscordApplicationId: async () => ({ kind: "resolved", applicationId: "app-1" }),
  parseApplicationIdFromToken: (token: string) => {
    const segment = token.trim().split(".")[0];
    if (!segment) {
      return undefined;
    }
    try {
      const decoded = Buffer.from(segment, "base64url").toString("utf8").trim();
      return /^\d+$/.test(decoded) ? decoded : undefined;
    } catch {
      return undefined;
    }
  },
}));

vi.mock("../token.js", () => ({
  normalizeDiscordToken: (value?: string) => value,
}));

vi.mock("../voice/command.js", () => ({
  DISCORD_VOICE_COMMAND_SPEC: {
    name: "vc",
    description: "Voice channel controls",
    acceptsArgs: false,
  },
  createDiscordVoiceCommand: () => ({ name: "vc" }),
}));

vi.mock("../monitor/agent-components.js", () => ({
  createAgentComponentButton: () => ({ id: "btn" }),
  createAgentSelectMenu: () => ({ id: "menu" }),
  createDiscordComponentButton: () => ({ id: "btn2" }),
  createDiscordComponentChannelSelect: () => ({ id: "channel" }),
  createDiscordComponentMentionableSelect: () => ({ id: "mentionable" }),
  createDiscordComponentModal: () => ({ id: "modal" }),
  createDiscordComponentRoleSelect: () => ({ id: "role" }),
  createDiscordComponentStringSelect: () => ({ id: "string" }),
  createDiscordComponentUserSelect: () => ({ id: "user" }),
}));

vi.mock("../monitor/auto-presence.js", () => ({
  createDiscordAutoPresenceController: createDiscordAutoPresenceControllerMock,
}));

vi.mock("../monitor/commands.js", () => ({
  resolveDiscordSlashCommandConfig: () => ({ ephemeral: false }),
}));

vi.mock("../monitor/exec-approvals.js", () => ({
  createExecApprovalButton: createExecApprovalButtonMock,
  createDiscordExecApprovalButtonContext: createDiscordExecApprovalButtonContextMock,
}));

vi.mock("../monitor/gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: () =>
    clientGetPluginMock("gateway") ?? {
      id: "gateway",
      emitter: new EventEmitter(),
      isConnected: false,
      disconnect: vi.fn(),
    },
  waitForDiscordGatewayPluginRegistration: () => undefined,
}));

vi.mock("../monitor/listeners.js", () => ({
  DiscordInteractionListener: function DiscordInteractionListener() {},
  DiscordMessageListener: function DiscordMessageListener() {},
  DiscordPresenceListener: function DiscordPresenceListener() {},
  DiscordReactionListener: function DiscordReactionListener() {},
  DiscordReactionRemoveListener: function DiscordReactionRemoveListener() {},
  DiscordThreadDeleteListener: function DiscordThreadDeleteListener() {},
  DiscordThreadReadyListener: function DiscordThreadReadyListener() {},
  DiscordThreadUpdateListener: function DiscordThreadUpdateListener() {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("../monitor/message-handler.js", () => ({
  createDiscordMessageHandler: createDiscordMessageHandlerMock,
}));

vi.mock("../monitor/native-command.js", () => ({
  createDiscordCommandArgFallbackButton: () => ({ id: "arg-fallback" }),
  createDiscordModelPickerFallbackButton: () => ({ id: "model-fallback-btn" }),
  createDiscordModelPickerFallbackSelect: () => ({ id: "model-fallback-select" }),
  createDiscordNativeCommand: createDiscordNativeCommandMock,
}));

vi.mock("../monitor/presence.js", () => ({
  resolveDiscordPresenceUpdate: () => undefined,
}));

vi.mock("../monitor/provider.allowlist.js", () => ({
  resolveDiscordAllowlistConfig: resolveDiscordAllowlistConfigMock,
}));

vi.mock("../monitor/provider.lifecycle.js", () => ({
  runDiscordGatewayLifecycle: monitorLifecycleMock,
}));

vi.mock("../monitor/rest-fetch.js", () => ({
  resolveDiscordRestFetch: () => async () => {
    throw new Error("offline");
  },
}));

vi.mock("../monitor/thread-bindings.js", () => ({
  createNoopThreadBindingManager: createNoopThreadBindingManagerMock,
  createThreadBindingManager: createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartup: reconcileAcpThreadBindingsOnStartupMock,
  resolveThreadBindingIdleTimeoutMs: vi.fn(() => 24 * 60 * 60 * 1000),
}));

vi.mock("../monitor/thread-bindings.manager.js", () => ({
  createThreadBindingManager: createThreadBindingManagerMock,
}));
