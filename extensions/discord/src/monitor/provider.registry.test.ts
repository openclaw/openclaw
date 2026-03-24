import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../../../../src/plugins/commands.js";
import type { RuntimeEnv } from "../../../../src/runtime.js";

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

const {
  clientConstructorOptionsMock,
  clientFetchUserMock,
  clientHandleDeployRequestMock,
  createDiscordAutoPresenceControllerMock,
  createDiscordMessageHandlerMock,
  createDiscordNativeCommandMock,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  getAcpSessionStatusMock,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  reconcileAcpThreadBindingsOnStartupMock,
  resolveDiscordAccountMock,
  resolveDiscordAllowlistConfigMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
} = vi.hoisted(() => ({
  clientConstructorOptionsMock: vi.fn(),
  clientFetchUserMock: vi.fn(async (_target: string) => ({ id: "bot-1" })),
  clientHandleDeployRequestMock: vi.fn(async () => undefined),
  createDiscordAutoPresenceControllerMock: vi.fn(() => ({
    enabled: false,
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
    runNow: vi.fn(),
  })),
  createDiscordMessageHandlerMock: vi.fn(() =>
    Object.assign(
      vi.fn(async () => undefined),
      {
        deactivate: vi.fn(),
      },
    ),
  ),
  createDiscordNativeCommandMock: vi.fn((params: { command: { name: string } }) => ({
    name: params.command.name,
  })),
  createNoopThreadBindingManagerMock: vi.fn(() => ({ stop: vi.fn() })),
  createThreadBindingManagerMock: vi.fn(() => ({ stop: vi.fn() })),
  getAcpSessionStatusMock: vi.fn(
    async (_params: { cfg: OpenClawConfig; sessionKey: string; signal?: AbortSignal }) => ({
      state: "idle",
    }),
  ),
  listNativeCommandSpecsForConfigMock: vi.fn<() => NativeCommandSpecMock[]>(() => [
    { name: "status", description: "Status", acceptsArgs: false },
  ]),
  listSkillCommandsForAgentsMock: vi.fn(() => []),
  monitorLifecycleMock: vi.fn(async (params: { threadBindings: { stop: () => void } }) => {
    params.threadBindings.stop();
  }),
  reconcileAcpThreadBindingsOnStartupMock: vi.fn(() => ({
    checked: 0,
    removed: 0,
    staleSessionKeys: [],
  })),
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
}));

vi.mock("@buape/carbon", () => {
  class ReadyListener {}
  class RateLimitError extends Error {
    status = 429;
    retryAfter = 0;
    scope: string | null = null;
    bucket: string | null = null;
  }
  class Client {
    listeners: unknown[];
    rest: { put: ReturnType<typeof vi.fn> };
    constructor(options: unknown, handlers: { listeners?: unknown[] }) {
      clientConstructorOptionsMock(options);
      this.listeners = handlers.listeners ?? [];
      this.rest = { put: vi.fn(async () => undefined) };
    }
    async handleDeployRequest() {
      return await clientHandleDeployRequestMock();
    }
    async fetchUser(target: string) {
      return await clientFetchUserMock(target);
    }
    getPlugin() {
      return undefined;
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
  isVerbose: () => false,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
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

describe("monitorDiscordProvider real plugin registry", () => {
  const baseRuntime = (): RuntimeEnv => ({
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  });

  const baseConfig = (): OpenClawConfig =>
    ({
      channels: {
        discord: {
          accounts: {
            default: {},
          },
        },
      },
    }) as OpenClawConfig;

  beforeEach(() => {
    clearPluginCommands();
    clientConstructorOptionsMock.mockClear();
    clientFetchUserMock.mockClear().mockResolvedValue({ id: "bot-1" });
    clientHandleDeployRequestMock.mockClear().mockResolvedValue(undefined);
    createDiscordAutoPresenceControllerMock.mockClear();
    createDiscordMessageHandlerMock.mockClear();
    createDiscordNativeCommandMock.mockClear();
    createNoopThreadBindingManagerMock.mockClear();
    createThreadBindingManagerMock.mockClear();
    getAcpSessionStatusMock.mockClear().mockResolvedValue({ state: "idle" });
    listNativeCommandSpecsForConfigMock
      .mockClear()
      .mockReturnValue([{ name: "status", description: "Status", acceptsArgs: false }]);
    listSkillCommandsForAgentsMock.mockClear().mockReturnValue([]);
    monitorLifecycleMock.mockClear().mockImplementation(async (params) => {
      params.threadBindings.stop();
    });
    reconcileAcpThreadBindingsOnStartupMock.mockClear().mockReturnValue({
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
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
  });

  it("registers plugin commands from the real registry as native Discord commands", async () => {
    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const commandNames = (createDiscordNativeCommandMock.mock.calls as Array<unknown[]>)
      .map((call) => (call[0] as { command?: { name?: string } } | undefined)?.command?.name)
      .filter((value): value is string => typeof value === "string");

    expect(commandNames).toContain("status");
    expect(commandNames).toContain("pair");
    expect(clientHandleDeployRequestMock).toHaveBeenCalledTimes(1);
    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
  });
});
