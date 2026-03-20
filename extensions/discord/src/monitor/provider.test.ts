import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../../../src/acp/runtime/errors.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import {
  baseConfig,
  baseRuntime,
  getFirstDiscordMessageHandlerParams,
  getProviderMonitorTestMocks,
  resetDiscordProviderMonitorMocks,
} from "../../../../test/helpers/extensions/discord-provider.test-support.js";

const {
  clientConstructorOptionsMock,
  clientFetchUserMock,
  clientGetPluginMock,
  clientHandleDeployRequestMock,
  createDiscordAutoPresenceControllerMock,
  createDiscordMessageHandlerMock,
  createDiscordNativeCommandMock,
  createdBindingManagers,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  getAcpSessionStatusMock,
  getPluginCommandSpecsMock,
  isVerboseMock,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  reconcileAcpThreadBindingsOnStartupMock,
  resolveDiscordAllowlistConfigMock,
  resolveDiscordAccountMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  shouldLogVerboseMock,
  voiceRuntimeModuleLoadedMock,
} = getProviderMonitorTestMocks();

function createConfigWithDiscordAccount(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      discord: {
        accounts: {
          default: {
            token: "MTIz.abc.def",
            ...overrides,
          },
        },
      },
    },
  } as OpenClawConfig;
}

vi.mock("openclaw/plugin-sdk/plugin-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-runtime")>(
    "openclaw/plugin-sdk/plugin-runtime",
  );
  return {
    ...actual,
    getPluginCommandSpecs: getPluginCommandSpecsMock,
  };
});

vi.mock("../voice/manager.runtime.js", () => {
  voiceRuntimeModuleLoadedMock();
  return {
    DiscordVoiceManager: class DiscordVoiceManager {},
    DiscordVoiceReadyListener: class DiscordVoiceReadyListener {},
  };
});

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

  const getConstructedEventQueue = (): { listenerTimeout?: number } | undefined => {
    expect(clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    const opts = clientConstructorOptionsMock.mock.calls[0]?.[0] as {
      eventQueue?: { listenerTimeout?: number };
    };
    return opts.eventQueue;
  };

  const getConstructedClientOptions = (): {
    eventQueue?: { listenerTimeout?: number };
  } => {
    expect(clientConstructorOptionsMock).toHaveBeenCalledTimes(1);
    return (
      (clientConstructorOptionsMock.mock.calls[0]?.[0] as {
        eventQueue?: { listenerTimeout?: number };
      }) ?? {}
    );
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
    vi.resetModules();
    resetDiscordProviderMonitorMocks();
    vi.doMock("../accounts.js", () => ({
      resolveDiscordAccount: (...args: Parameters<typeof resolveDiscordAccountMock>) =>
        resolveDiscordAccountMock(...args),
    }));
    vi.doMock("../probe.js", () => ({
      fetchDiscordApplicationId: async () => "app-1",
    }));
    vi.doMock("../token.js", () => ({
      normalizeDiscordToken: (value?: string) => value,
    }));
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
      token: "MTIz.abc.def",
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
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
        eventQueue: { listenerTimeout: 300_000 },
      },
    });
    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const eventQueue = getConstructedEventQueue();
    expect(eventQueue?.listenerTimeout).toBe(300_000);
  });

  it("does not reuse eventQueue.listenerTimeout as the queued inbound worker timeout", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: createConfigWithDiscordAccount({
        eventQueue: { listenerTimeout: 50_000 },
      }),
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
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "MTIz.abc.def",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
        inboundWorker: { runTimeoutMs: 300_000 },
      },
    });
    const { monitorDiscordProvider } = await import("./provider.js");

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

  it("registers plugin commands from the real registry as native Discord commands", async () => {
    const { clearPluginCommands, getPluginCommandSpecs, registerPluginCommand } =
      await import("../../../../src/plugins/commands.js");
    clearPluginCommands();
    const { monitorDiscordProvider } = await import("./provider.js");
    listNativeCommandSpecsForConfigMock.mockReturnValue([
      { name: "status", description: "Status", acceptsArgs: false },
    ]);
    getPluginCommandSpecsMock.mockImplementation((provider?: string) =>
      getPluginCommandSpecs(provider),
    );

    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

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

  it("configures Carbon native deploy by default", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(clientHandleDeployRequestMock).toHaveBeenCalledTimes(1);
    expect(getConstructedClientOptions().eventQueue?.listenerTimeout).toBe(120_000);
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

  it("logs Discord startup phases and early gateway debug events", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    const runtime = baseRuntime();
    const emitter = new EventEmitter();
    const gateway = { emitter, isConnected: true, reconnectAttempts: 0 };
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? gateway : undefined,
    );
    clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("debug", "WebSocket connection opened");
      return { id: "bot-1", username: "Molty" };
    });
    isVerboseMock.mockReturnValue(true);

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    const messages = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes("fetch-application-id:start"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-application-id:done"))).toBe(true);
    expect(messages.some((msg) => msg.includes("deploy-commands:start"))).toBe(true);
    expect(messages.some((msg) => msg.includes("deploy-commands:done"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-bot-identity:start"))).toBe(true);
    expect(messages.some((msg) => msg.includes("fetch-bot-identity:done"))).toBe(true);
    expect(
      messages.some(
        (msg) => msg.includes("gateway-debug") && msg.includes("WebSocket connection opened"),
      ),
    ).toBe(true);
  });

  it("keeps Discord startup chatter quiet by default", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    const runtime = baseRuntime();

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime,
    });

    const messages = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes("discord startup ["))).toBe(false);
  });
});
