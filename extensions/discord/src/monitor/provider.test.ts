import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../../../src/acp/runtime/errors.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import type { RuntimeEnv } from "../../../../src/runtime.js";

type NativeCommandSpecMock = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

type PluginCommandSpecMock = {
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
  voiceRuntimeModuleLoadedMock,
} = vi.hoisted(() => {
  const createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  return {
    clientHandleDeployRequestMock: vi.fn(async () => undefined),
    clientConstructorOptionsMock: vi.fn(),
    createDiscordAutoPresenceControllerMock: vi.fn(() => ({
      enabled: false,
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(),
      runNow: vi.fn(),
    })),
    clientFetchUserMock: vi.fn(async (_target: string) => ({ id: "bot-1" })),
    clientGetPluginMock: vi.fn<(_name: string) => unknown>(() => undefined),
    createDiscordNativeCommandMock: vi.fn(() => ({ name: "mock-command" })),
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
    voiceRuntimeModuleLoadedMock: vi.fn(),
  };
});

function mockResolvedDiscordAccountConfig(overrides: Record<string, unknown>) {
  resolveDiscordAccountMock.mockImplementation(() => ({
    accountId: "default",
    token: "cfg-token",
    config: {
      ...baseDiscordAccountConfig(),
      ...overrides,
    },
  }));
}

function getFirstDiscordMessageHandlerParams<T extends object>() {
  expect(createDiscordMessageHandlerMock).toHaveBeenCalledTimes(1);
  const firstCall = createDiscordMessageHandlerMock.mock.calls.at(0) as [T] | undefined;
  return firstCall?.[0];
}

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

vi.mock("../../../../src/auto-reply/chunk.js", () => ({
  resolveTextChunkLimit: () => 2000,
}));

vi.mock("../../../../src/acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    getSessionStatus: getAcpSessionStatusMock,
  }),
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
  danger: (v: string) => v,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
  warn: (v: string) => v,
}));

vi.mock("../../../../src/infra/errors.js", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

vi.mock("../../../../src/infra/retry-policy.js", () => ({
  createDiscordRetryRunner: () => async (run: () => Promise<unknown>) => run(),
}));

vi.mock("../../../../src/logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../../../src/plugins/commands.js", () => ({
  getPluginCommandSpecs: getPluginCommandSpecsMock,
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

vi.mock("../voice/manager.runtime.js", () => {
  voiceRuntimeModuleLoadedMock();
  return {
    DiscordVoiceManager: class DiscordVoiceManager {},
    DiscordVoiceReadyListener: class DiscordVoiceReadyListener {},
  };
});

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

vi.mock("./auto-presence.js", () => ({
  createDiscordAutoPresenceController: createDiscordAutoPresenceControllerMock,
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

describe("monitorDiscordProvider", () => {
  type ReconcileHealthProbeParams = {
    cfg: OpenClawConfig;
    accountId: string;
    sessionKey: string;
    binding: unknown;
    session: unknown;
  };

  type ReconcileStartupParams = {
    cfg: OpenClawConfig;
    healthProbe?: (
      params: ReconcileHealthProbeParams,
    ) => Promise<{ status: string; reason?: string }>;
  };

  const baseRuntime = (): RuntimeEnv => {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  };

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

  const getConstructedEventQueue = (): { listenerTimeout?: number } | undefined => {
    expect(clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    const opts = clientConstructorOptionsMock.mock.calls[0]?.[0] as {
      eventQueue?: { listenerTimeout?: number };
    };
    return opts.eventQueue;
  };

  const getHealthProbe = () => {
    expect(reconcileAcpThreadBindingsOnStartupMock).toHaveBeenCalledTimes(1);
    const firstCall = reconcileAcpThreadBindingsOnStartupMock.mock.calls.at(0) as
      | [ReconcileStartupParams]
      | undefined;
    const reconcileParams = firstCall?.[0];
    expect(typeof reconcileParams?.healthProbe).toBe("function");
    return reconcileParams?.healthProbe as NonNullable<ReconcileStartupParams["healthProbe"]>;
  };

  beforeEach(() => {
    clientHandleDeployRequestMock.mockClear().mockResolvedValue(undefined);
    clientConstructorOptionsMock.mockClear();
    createDiscordAutoPresenceControllerMock.mockClear().mockImplementation(() => ({
      enabled: false,
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(),
      runNow: vi.fn(),
    }));
    createDiscordMessageHandlerMock.mockClear().mockImplementation(() =>
      Object.assign(
        vi.fn(async () => undefined),
        {
          deactivate: vi.fn(),
        },
      ),
    );
    clientFetchUserMock.mockClear().mockResolvedValue({ id: "bot-1" });
    clientGetPluginMock.mockClear().mockReturnValue(undefined);
    createDiscordNativeCommandMock.mockClear().mockReturnValue({ name: "mock-command" });
    createNoopThreadBindingManagerMock.mockClear();
    createThreadBindingManagerMock.mockClear();
    reconcileAcpThreadBindingsOnStartupMock.mockClear().mockReturnValue({
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    });
    getAcpSessionStatusMock.mockClear().mockResolvedValue({ state: "idle" });
    createdBindingManagers.length = 0;
    getPluginCommandSpecsMock.mockClear().mockReturnValue([]);
    listNativeCommandSpecsForConfigMock
      .mockClear()
      .mockReturnValue([{ name: "cmd", description: "built-in", acceptsArgs: false }]);
    listSkillCommandsForAgentsMock.mockClear().mockReturnValue([]);
    monitorLifecycleMock.mockClear().mockImplementation(async (params) => {
      params.threadBindings.stop();
    });
    resolveDiscordAccountMock.mockClear();
    resolveDiscordAllowlistConfigMock.mockClear().mockResolvedValue({
      guildEntries: undefined,
      allowFrom: undefined,
    });
    resolveNativeCommandsEnabledMock.mockClear().mockReturnValue(true);
    resolveNativeSkillsEnabledMock.mockClear().mockReturnValue(false);
    voiceRuntimeModuleLoadedMock.mockClear();
  });

  it("stops thread bindings when startup fails before lifecycle begins", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    createDiscordNativeCommandMock.mockImplementation(() => {
      throw new Error("native command boom");
    });

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime: baseRuntime(),
      }),
    ).rejects.toThrow("native command boom");

    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("does not double-stop thread bindings when lifecycle performs cleanup", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(reconcileAcpThreadBindingsOnStartupMock).toHaveBeenCalledTimes(1);
  });

  it("does not load the Discord voice runtime when voice is disabled", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(voiceRuntimeModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("loads the Discord voice runtime only when voice is enabled", async () => {
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "cfg-token",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: true },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
      },
    });
    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(voiceRuntimeModuleLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("treats ACP error status as uncertain during startup thread-binding probes", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    getAcpSessionStatusMock.mockResolvedValue({ state: "error" });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const probeResult = await getHealthProbe()({
      cfg: baseConfig(),
      accountId: "default",
      sessionKey: "agent:codex:acp:error",
      binding: {} as never,
      session: {
        acp: {
          state: "error",
          lastActivityAt: Date.now(),
        },
      } as never,
    });

    expect(probeResult).toEqual({
      status: "uncertain",
      reason: "status-error-state",
    });
  });

  it("classifies typed ACP session init failures as stale", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    getAcpSessionStatusMock.mockRejectedValue(
      new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "missing ACP metadata"),
    );

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const probeResult = await getHealthProbe()({
      cfg: baseConfig(),
      accountId: "default",
      sessionKey: "agent:codex:acp:stale",
      binding: {} as never,
      session: {
        acp: {
          state: "idle",
          lastActivityAt: Date.now(),
        },
      } as never,
    });

    expect(probeResult).toEqual({
      status: "stale",
      reason: "session-init-failed",
    });
  });

  it("classifies typed non-init ACP errors as uncertain when not stale-running", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    getAcpSessionStatusMock.mockRejectedValue(
      new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "runtime unavailable"),
    );

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const probeResult = await getHealthProbe()({
      cfg: baseConfig(),
      accountId: "default",
      sessionKey: "agent:codex:acp:uncertain",
      binding: {} as never,
      session: {
        acp: {
          state: "idle",
          lastActivityAt: Date.now(),
        },
      } as never,
    });

    expect(probeResult).toEqual({
      status: "uncertain",
      reason: "status-error",
    });
  });

  it("aborts timed-out ACP status probes during startup thread-binding health checks", async () => {
    vi.useFakeTimers();
    try {
      const { monitorDiscordProvider } = await import("./provider.js");
      getAcpSessionStatusMock.mockImplementation(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );

      await monitorDiscordProvider({
        config: baseConfig(),
        runtime: baseRuntime(),
      });

      const probePromise = getHealthProbe()({
        cfg: baseConfig(),
        accountId: "default",
        sessionKey: "agent:codex:acp:timeout",
        binding: {} as never,
        session: {
          acp: {
            state: "idle",
            lastActivityAt: Date.now(),
          },
        } as never,
      });

      await vi.advanceTimersByTimeAsync(8_100);
      await expect(probePromise).resolves.toEqual({
        status: "uncertain",
        reason: "status-timeout",
      });

      const firstCall = getAcpSessionStatusMock.mock.calls[0]?.[0] as
        | { signal?: AbortSignal }
        | undefined;
      expect(firstCall?.signal).toBeDefined();
      expect(firstCall?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to legacy missing-session message classification", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    getAcpSessionStatusMock.mockRejectedValue(new Error("ACP session metadata missing"));

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const probeResult = await getHealthProbe()({
      cfg: baseConfig(),
      accountId: "default",
      sessionKey: "agent:codex:acp:legacy",
      binding: {} as never,
      session: {
        acp: {
          state: "idle",
          lastActivityAt: Date.now(),
        },
      } as never,
    });

    expect(probeResult).toEqual({
      status: "stale",
      reason: "session-missing",
    });
  });

  it("captures gateway errors emitted before lifecycle wait starts", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    const emitter = new EventEmitter();
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? { emitter, disconnect: vi.fn() } : undefined,
    );
    clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("error", new Error("Fatal Gateway error: 4014"));
      return { id: "bot-1" };
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    const lifecycleArgs = monitorLifecycleMock.mock.calls[0]?.[0] as {
      pendingGatewayErrors?: unknown[];
    };
    expect(lifecycleArgs.pendingGatewayErrors).toHaveLength(1);
    expect(String(lifecycleArgs.pendingGatewayErrors?.[0])).toContain("4014");
  });

  it("passes default eventQueue.listenerTimeout of 120s to Carbon Client", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const eventQueue = getConstructedEventQueue();
    expect(eventQueue).toBeDefined();
    expect(eventQueue?.listenerTimeout).toBe(120_000);
  });

  it("forwards custom eventQueue config from discord config to Carbon Client", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    mockResolvedDiscordAccountConfig({
      eventQueue: { listenerTimeout: 300_000 },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const eventQueue = getConstructedEventQueue();
    expect(eventQueue?.listenerTimeout).toBe(300_000);
  });

  it("does not reuse eventQueue.listenerTimeout as the queued inbound worker timeout", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    mockResolvedDiscordAccountConfig({
      eventQueue: { listenerTimeout: 50_000 },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const params = getFirstDiscordMessageHandlerParams<{
      workerRunTimeoutMs?: number;
      listenerTimeoutMs?: number;
    }>();
    expect(params?.workerRunTimeoutMs).toBeUndefined();
    expect("listenerTimeoutMs" in (params ?? {})).toBe(false);
  });

  it("forwards inbound worker timeout config to the Discord message handler", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    mockResolvedDiscordAccountConfig({
      inboundWorker: { runTimeoutMs: 300_000 },
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const params = getFirstDiscordMessageHandlerParams<{
      workerRunTimeoutMs?: number;
    }>();
    expect(params?.workerRunTimeoutMs).toBe(300_000);
  });

  it("registers plugin commands as native Discord commands", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    listNativeCommandSpecsForConfigMock.mockReturnValue([
      { name: "cmd", description: "built-in", acceptsArgs: false },
    ]);
    getPluginCommandSpecsMock.mockReturnValue([
      { name: "cron_jobs", description: "List cron jobs", acceptsArgs: false },
    ]);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const commandNames = (createDiscordNativeCommandMock.mock.calls as Array<unknown[]>)
      .map((call) => (call[0] as { command?: { name?: string } } | undefined)?.command?.name)
      .filter((value): value is string => typeof value === "string");
    expect(getPluginCommandSpecsMock).toHaveBeenCalledWith("discord");
    expect(commandNames).toContain("cmd");
    expect(commandNames).toContain("cron_jobs");
  });

  it("continues startup when Discord daily slash-command create quota is exhausted", async () => {
    const { RateLimitError } = await import("@buape/carbon");
    const { monitorDiscordProvider } = await import("./provider.js");
    const runtime = baseRuntime();
    const rateLimitError = new RateLimitError(
      new Response(null, {
        status: 429,
        headers: {
          "X-RateLimit-Scope": "shared",
          "X-RateLimit-Bucket": "bucket-1",
        },
      }),
      {
        message: "Max number of daily application command creates has been reached (200)",
        retry_after: 193.632,
        global: false,
      },
    );
    rateLimitError.discordCode = 30034;
    clientHandleDeployRequestMock.mockRejectedValueOnce(rateLimitError);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    expect(clientHandleDeployRequestMock).toHaveBeenCalledTimes(1);
    expect(clientFetchUserMock).toHaveBeenCalledWith("@me");
    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("native command deploy skipped"),
    );
  });

  it("reports connected status on startup and shutdown", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    const setStatus = vi.fn();
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? { isConnected: true } : undefined,
    );

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
      setStatus,
    });

    const connectedTrue = setStatus.mock.calls.find((call) => call[0]?.connected === true);
    const connectedFalse = setStatus.mock.calls.find((call) => call[0]?.connected === false);

    expect(connectedTrue).toBeDefined();
    expect(connectedFalse).toBeDefined();
  });

  it("skips reaction listeners when all guilds have reactionNotifications off and DMs disabled", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    const { registerDiscordListener, DiscordReactionListener, DiscordReactionRemoveListener } =
      await import("./listeners.js");

    mockResolvedDiscordAccountConfig({
      dm: { enabled: false, groupEnabled: false },
    });
    resolveDiscordAllowlistConfigMock.mockResolvedValue({
      guildEntries: {
        "guild-1": { reactionNotifications: "off" as const },
        "guild-2": { reactionNotifications: "off" as const },
      },
      allowFrom: undefined,
    });
    vi.mocked(registerDiscordListener).mockClear();

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const registeredListeners = vi.mocked(registerDiscordListener).mock.calls.map((c) => c[1]);
    const hasReactionListener = registeredListeners.some(
      (l) => l instanceof DiscordReactionListener,
    );
    const hasReactionRemoveListener = registeredListeners.some(
      (l) => l instanceof DiscordReactionRemoveListener,
    );

    expect(hasReactionListener).toBe(false);
    expect(hasReactionRemoveListener).toBe(false);
  });

  it("registers reaction listeners when at least one guild allows reactions", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    const { registerDiscordListener, DiscordReactionListener, DiscordReactionRemoveListener } =
      await import("./listeners.js");

    mockResolvedDiscordAccountConfig({
      dm: { enabled: false, groupEnabled: false },
    });
    resolveDiscordAllowlistConfigMock.mockResolvedValue({
      guildEntries: {
        "guild-1": { reactionNotifications: "off" as const },
        "guild-2": { reactionNotifications: "own" as const },
      },
      allowFrom: undefined,
    });
    vi.mocked(registerDiscordListener).mockClear();

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const registeredListeners = vi.mocked(registerDiscordListener).mock.calls.map((c) => c[1]);
    const hasReactionListener = registeredListeners.some(
      (l) => l instanceof DiscordReactionListener,
    );
    const hasReactionRemoveListener = registeredListeners.some(
      (l) => l instanceof DiscordReactionRemoveListener,
    );

    expect(hasReactionListener).toBe(true);
    expect(hasReactionRemoveListener).toBe(true);
  });
});
