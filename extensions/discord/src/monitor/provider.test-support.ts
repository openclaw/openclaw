import type { MockFn } from "openclaw/plugin-sdk/test-utils";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import type { RuntimeEnv } from "../../../../src/runtime.js";

export type NativeCommandSpecMock = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

export type PluginCommandSpecMock = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

type AnyMock = MockFn;

type ProviderMonitorTestMocks = {
  clientHandleDeployRequestMock: AnyMock;
  clientFetchUserMock: AnyMock;
  clientGetPluginMock: AnyMock;
  clientConstructorOptionsMock: AnyMock;
  createDiscordAutoPresenceControllerMock: AnyMock;
  createDiscordNativeCommandMock: AnyMock;
  createDiscordMessageHandlerMock: AnyMock;
  createNoopThreadBindingManagerMock: AnyMock;
  createThreadBindingManagerMock: AnyMock;
  reconcileAcpThreadBindingsOnStartupMock: AnyMock;
  createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }>;
  getAcpSessionStatusMock: AnyMock;
  getPluginCommandSpecsMock: AnyMock;
  listNativeCommandSpecsForConfigMock: AnyMock;
  listSkillCommandsForAgentsMock: AnyMock;
  monitorLifecycleMock: AnyMock;
  resolveDiscordAccountMock: AnyMock;
  resolveDiscordAllowlistConfigMock: AnyMock;
  resolveNativeCommandsEnabledMock: AnyMock;
  resolveNativeSkillsEnabledMock: AnyMock;
  isVerboseMock: AnyMock;
  shouldLogVerboseMock: AnyMock;
  voiceRuntimeModuleLoadedMock: AnyMock;
};

export function baseDiscordAccountConfig() {
  return {
    commands: { native: true, nativeSkills: false },
    voice: { enabled: false },
    agentComponents: { enabled: false },
    execApprovals: { enabled: false },
  };
}

const providerMonitorTestMocks: ProviderMonitorTestMocks = vi.hoisted(() => {
  const createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const isVerboseMock = vi.fn(() => false);
  const shouldLogVerboseMock = vi.fn(() => false);

  return {
    clientHandleDeployRequestMock: vi.fn(async () => undefined),
    clientFetchUserMock: vi.fn(async (_target: string) => ({ id: "bot-1" })),
    clientGetPluginMock: vi.fn<(_name: string) => unknown>(() => undefined),
    clientConstructorOptionsMock: vi.fn(),
    createDiscordAutoPresenceControllerMock: vi.fn(() => ({
      enabled: false,
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(),
      runNow: vi.fn(),
    })),
    createDiscordNativeCommandMock: vi.fn((params?: { command?: { name?: string } }) => ({
      name: params?.command?.name ?? "mock-command",
    })),
    createDiscordMessageHandlerMock: vi.fn(() =>
      Object.assign(
        vi.fn(async () => undefined),
        {
          deactivate: vi.fn(),
        },
      ),
    ),
    createNoopThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    createThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    reconcileAcpThreadBindingsOnStartupMock: vi.fn(() => ({
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    })),
    createdBindingManagers,
    getAcpSessionStatusMock: vi.fn(
      async (_params: { cfg: OpenClawConfig; sessionKey: string; signal?: AbortSignal }) => ({
        state: "idle",
      }),
    ),
    getPluginCommandSpecsMock: vi.fn<() => PluginCommandSpecMock[]>(() => []),
    listNativeCommandSpecsForConfigMock: vi.fn<() => NativeCommandSpecMock[]>(() => [
      { name: "cmd", description: "built-in", acceptsArgs: false },
    ]),
    listSkillCommandsForAgentsMock: vi.fn(() => []),
    monitorLifecycleMock: vi.fn(async (params: { threadBindings: { stop: () => void } }) => {
      params.threadBindings.stop();
    }),
    resolveDiscordAccountMock: vi.fn(() => ({
      accountId: "default",
      token: "cfg-token",
      config: baseDiscordAccountConfig(),
    })),
    resolveDiscordAllowlistConfigMock: vi.fn(async () => ({
      guildEntries: undefined,
      allowFrom: undefined,
    })),
    resolveNativeCommandsEnabledMock: vi.fn(() => true),
    resolveNativeSkillsEnabledMock: vi.fn(() => false),
    isVerboseMock,
    shouldLogVerboseMock,
    voiceRuntimeModuleLoadedMock: vi.fn(),
  };
});

const {
  clientHandleDeployRequestMock,
  clientFetchUserMock,
  clientGetPluginMock,
  clientConstructorOptionsMock,
  createDiscordAutoPresenceControllerMock,
  createDiscordNativeCommandMock,
  createDiscordMessageHandlerMock,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartupMock,
  createdBindingManagers,
  getAcpSessionStatusMock,
  getPluginCommandSpecsMock,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  resolveDiscordAccountMock,
  resolveDiscordAllowlistConfigMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  isVerboseMock,
  shouldLogVerboseMock,
  voiceRuntimeModuleLoadedMock,
} = providerMonitorTestMocks;

export function getProviderMonitorTestMocks(): typeof providerMonitorTestMocks {
  return providerMonitorTestMocks;
}

export function mockResolvedDiscordAccountConfig(overrides: Record<string, unknown>) {
  resolveDiscordAccountMock.mockImplementation(() => ({
    accountId: "default",
    token: "cfg-token",
    config: {
      ...baseDiscordAccountConfig(),
      ...overrides,
    },
  }));
}

export function getFirstDiscordMessageHandlerParams<T extends object>() {
  expect(createDiscordMessageHandlerMock).toHaveBeenCalledTimes(1);
  const firstCall = createDiscordMessageHandlerMock.mock.calls.at(0) as [T] | undefined;
  return firstCall?.[0];
}

export function resetDiscordProviderMonitorMocks(params?: {
  nativeCommands?: NativeCommandSpecMock[];
}) {
  clientHandleDeployRequestMock.mockClear().mockResolvedValue(undefined);
  clientFetchUserMock.mockClear().mockResolvedValue({ id: "bot-1" });
  clientGetPluginMock.mockClear().mockReturnValue(undefined);
  clientConstructorOptionsMock.mockClear();
  createDiscordAutoPresenceControllerMock.mockClear().mockImplementation(() => ({
    enabled: false,
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
    runNow: vi.fn(),
  }));
  createDiscordNativeCommandMock.mockClear().mockImplementation((input) => ({
    name: input?.command?.name ?? "mock-command",
  }));
  createDiscordMessageHandlerMock.mockClear().mockImplementation(() =>
    Object.assign(
      vi.fn(async () => undefined),
      {
        deactivate: vi.fn(),
      },
    ),
  );
  createNoopThreadBindingManagerMock.mockClear();
  createThreadBindingManagerMock.mockClear();
  reconcileAcpThreadBindingsOnStartupMock.mockClear().mockReturnValue({
    checked: 0,
    removed: 0,
    staleSessionKeys: [],
  });
  createdBindingManagers.length = 0;
  getAcpSessionStatusMock.mockClear().mockResolvedValue({ state: "idle" });
  getPluginCommandSpecsMock.mockClear().mockReturnValue([]);
  listNativeCommandSpecsForConfigMock
    .mockClear()
    .mockReturnValue(
      params?.nativeCommands ?? [{ name: "cmd", description: "built-in", acceptsArgs: false }],
    );
  listSkillCommandsForAgentsMock.mockClear().mockReturnValue([]);
  monitorLifecycleMock.mockClear().mockImplementation(async (monitorParams) => {
    monitorParams.threadBindings.stop();
  });
  resolveDiscordAccountMock.mockClear().mockReturnValue({
    accountId: "default",
    token: "cfg-token",
    config: baseDiscordAccountConfig(),
  });
  resolveDiscordAllowlistConfigMock.mockClear().mockResolvedValue({
    guildEntries: undefined,
    allowFrom: undefined,
  });
  resolveNativeCommandsEnabledMock.mockClear().mockReturnValue(true);
  resolveNativeSkillsEnabledMock.mockClear().mockReturnValue(false);
  isVerboseMock.mockClear().mockReturnValue(false);
  shouldLogVerboseMock.mockClear().mockReturnValue(false);
  voiceRuntimeModuleLoadedMock.mockClear();
}

export const baseRuntime = (): RuntimeEnv => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

export const baseConfig = (): OpenClawConfig =>
  ({
    channels: {
      discord: {
        accounts: {
          default: {},
        },
      },
    },
  }) as OpenClawConfig;

vi.mock("@buape/carbon", () => {
  class ReadyListener {}
  class RateLimitError extends Error {
    status = 429;
    discordCode?: number;
    retryAfter: number;
    scope: string | null;
    bucket: string | null;
    constructor(
      response: Response,
      body: { message: string; retry_after: number; global: boolean },
    ) {
      super(body.message);
      this.retryAfter = body.retry_after;
      this.scope = body.global ? "global" : response.headers.get("X-RateLimit-Scope");
      this.bucket = response.headers.get("X-RateLimit-Bucket");
    }
  }
  class Client {
    listeners: unknown[];
    rest: { put: ReturnType<typeof vi.fn> };
    options: unknown;
    constructor(options: unknown, handlers: { listeners?: unknown[] }) {
      this.options = options;
      this.listeners = handlers.listeners ?? [];
      this.rest = { put: vi.fn(async () => undefined) };
      clientConstructorOptionsMock(options);
    }
    async handleDeployRequest() {
      return await clientHandleDeployRequestMock();
    }
    async fetchUser(target: string) {
      return await clientFetchUserMock(target);
    }
    getPlugin(name: string) {
      return clientGetPluginMock(name);
    }
  }
  return { Client, RateLimitError, ReadyListener };
});

vi.mock("@buape/carbon/gateway", () => ({
  GatewayCloseCodes: { DisallowedIntents: 4014 },
}));

vi.mock("@buape/carbon/voice", () => ({
  VoicePlugin: class VoicePlugin {},
}));

vi.mock("../../../../src/acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    getSessionStatus: getAcpSessionStatusMock,
  }),
}));

vi.mock("../../../../src/auto-reply/chunk.js", () => ({
  resolveTextChunkLimit: () => 2000,
}));

vi.mock("../../../../src/auto-reply/commands-registry.js", () => ({
  listNativeCommandSpecsForConfig: listNativeCommandSpecsForConfigMock,
}));

vi.mock("../../../../src/auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents: listSkillCommandsForAgentsMock,
}));

vi.mock("../../../../src/config/commands.js", () => ({
  isNativeCommandsExplicitlyDisabled: () => false,
  resolveNativeCommandsEnabled: resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabled: resolveNativeSkillsEnabledMock,
}));

vi.mock("../../../../src/config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../../../../src/globals.js", () => ({
  danger: (value: string) => value,
  isVerbose: isVerboseMock,
  logVerbose: vi.fn(),
  shouldLogVerbose: shouldLogVerboseMock,
  warn: (value: string) => value,
}));

vi.mock("../../../../src/infra/errors.js", () => ({
  formatErrorMessage: (error: unknown) => String(error),
}));

vi.mock("../../../../src/infra/retry-policy.js", () => ({
  createDiscordRetryRunner: () => async (run: () => Promise<unknown>) => run(),
}));

vi.mock("../../../../src/logging/subsystem.js", () => ({
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
}));

vi.mock("../../../../src/runtime.js", () => ({
  createNonExitingRuntime: () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }),
}));

vi.mock("../accounts.js", () => ({
  resolveDiscordAccount: resolveDiscordAccountMock,
}));

vi.mock("../probe.js", () => ({
  fetchDiscordApplicationId: async () => "app-1",
}));

vi.mock("../token.js", () => ({
  normalizeDiscordToken: (value?: string) => value,
}));

vi.mock("../voice/command.js", () => ({
  createDiscordVoiceCommand: () => ({ name: "voice-command" }),
}));

vi.mock("./agent-components.js", () => ({
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

vi.mock("./auto-presence.js", () => ({
  createDiscordAutoPresenceController: createDiscordAutoPresenceControllerMock,
}));

vi.mock("./commands.js", () => ({
  resolveDiscordSlashCommandConfig: () => ({ ephemeral: false }),
}));

vi.mock("./exec-approvals.js", () => ({
  createExecApprovalButton: () => ({ id: "exec-approval" }),
  DiscordExecApprovalHandler: class DiscordExecApprovalHandler {
    async start() {
      return undefined;
    }
    async stop() {
      return undefined;
    }
  },
}));

vi.mock("./gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: () => ({ id: "gateway-plugin" }),
}));

vi.mock("./listeners.js", () => ({
  DiscordMessageListener: class DiscordMessageListener {},
  DiscordPresenceListener: class DiscordPresenceListener {},
  DiscordReactionListener: class DiscordReactionListener {},
  DiscordReactionRemoveListener: class DiscordReactionRemoveListener {},
  DiscordThreadUpdateListener: class DiscordThreadUpdateListener {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("./message-handler.js", () => ({
  createDiscordMessageHandler: createDiscordMessageHandlerMock,
}));

vi.mock("./native-command.js", () => ({
  createDiscordCommandArgFallbackButton: () => ({ id: "arg-fallback" }),
  createDiscordModelPickerFallbackButton: () => ({ id: "model-fallback-btn" }),
  createDiscordModelPickerFallbackSelect: () => ({ id: "model-fallback-select" }),
  createDiscordNativeCommand: createDiscordNativeCommandMock,
}));

vi.mock("./presence.js", () => ({
  resolveDiscordPresenceUpdate: () => undefined,
}));

vi.mock("./provider.allowlist.js", () => ({
  resolveDiscordAllowlistConfig: resolveDiscordAllowlistConfigMock,
}));

vi.mock("./provider.lifecycle.js", () => ({
  runDiscordGatewayLifecycle: monitorLifecycleMock,
}));

vi.mock("./rest-fetch.js", () => ({
  resolveDiscordRestFetch: () => async () => undefined,
}));

vi.mock("./thread-bindings.js", () => ({
  createNoopThreadBindingManager: createNoopThreadBindingManagerMock,
  createThreadBindingManager: createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartup: reconcileAcpThreadBindingsOnStartupMock,
}));
