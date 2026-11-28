import { EventEmitter } from "node:events";
import { IncognitoSessionSyncAccessError } from "openclaw/plugin-sdk/acp-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError, RequestClient } from "../internal/rest.js";
import { firstMockArg } from "../test-support/mock-calls.js";
import {
  baseConfig,
  baseRuntime,
  getProviderMonitorTestMocks,
  resetDiscordProviderMonitorMocks,
} from "../test-support/provider.test-support.js";
import * as voiceCommands from "../voice/command.js";
import { DiscordGuildJoinIntroductionListener } from "./listeners.guild-join.js";
import { formatDiscordDeployErrorDetails } from "./provider.deploy-errors.js";
import type { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";

const {
  clientConstructorOptionsMock,
  clientDeployCommandsMock,
  clientFetchUserMock,
  clientGetPluginMock,
  createDiscordMessageHandlerMock,
  createDiscordNativeCommandMock,
  createdBindingManagers,
  createThreadBindingManagerMock,
  getAcpSessionStatusMock,
  isNativeCommandsExplicitlyDisabledMock,
  listNativeCommandSpecsForConfigMock,
  monitorLifecycleMock,
  reconcileAcpThreadBindingsOnStartupMock,
  resolveDiscordAccountMock,
  resolveNativeCommandsEnabledMock,
  voiceRuntimeModuleLoadedMock,
} = getProviderMonitorTestMocks();

const { voiceAutoJoinMock, probeDiscordApplicationIdMock } = vi.hoisted(() => ({
  voiceAutoJoinMock: vi.fn(async () => undefined),
  probeDiscordApplicationIdMock: vi.fn<typeof import("../probe.js").probeDiscordApplicationId>(),
}));

let monitorDiscordProvider: typeof import("./provider.js").monitorDiscordProvider;

function createAcpRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

type MockCallReader = { mock: { calls: unknown[][] } };

function mockLog(mock: unknown): string {
  return (mock as MockCallReader).mock.calls
    .map(([message]) => (typeof message === "string" ? message : ""))
    .join("\n");
}

describe("monitorDiscordProvider", () => {
  const probe = (name: string, state = "idle", lastActivityAt = Date.now()) => {
    const { healthProbe } = firstMockArg(
      reconcileAcpThreadBindingsOnStartupMock,
      "ACP startup reconciliation",
    ) as {
      healthProbe: (params: {
        sessionKey: string;
        session: { acp: { state: string; lastActivityAt: number } };
      }) => Promise<{ status: string; reason?: string }>;
    };
    return healthProbe({
      sessionKey: `agent:test:acp:${name}`,
      session: { acp: { state, lastActivityAt } },
    });
  };
  function configureAccount(
    config: NonNullable<OpenClawConfig["channels"]>["discord"] = {},
    token = "MTIz.abc.def",
  ) {
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token,
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
        ...config,
      },
    });
  }
  function expectStoppedBeforeLifecycle() {
    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  }
  function installGateway(isConnected = false) {
    const gateway = { emitter: new EventEmitter(), disconnect: vi.fn(), isConnected };
    clientGetPluginMock.mockImplementation((name) => (name === "gateway" ? gateway : undefined));
    return gateway;
  }
  function pause() {
    const entered = createDeferred<void>();
    const ready = createDeferred<void>();
    return {
      entered: entered.promise,
      release: ready.resolve,
      wait: () => {
        entered.resolve();
        return ready.promise;
      },
    };
  }

  beforeAll(async () => {
    vi.doMock("../accounts.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../accounts.js")>()),
      resolveDiscordAccount: (...args: Parameters<typeof resolveDiscordAccountMock>) =>
        resolveDiscordAccountMock(...args),
    }));
    vi.doMock("../probe.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../probe.js")>()),
      fetchDiscordApplicationId: async () => "app-1",
      probeDiscordApplicationId: probeDiscordApplicationIdMock,
    }));
    vi.doMock("../token.js", () => ({
      normalizeDiscordToken: (value?: string) => value,
    }));
    ({ monitorDiscordProvider } = await import("./provider.js"));
  });

  beforeEach(() => {
    resetDiscordProviderMonitorMocks();
    voiceAutoJoinMock.mockClear();
    probeDiscordApplicationIdMock.mockReset().mockResolvedValue({
      kind: "resolved",
      applicationId: "app-1",
    });
    vi.doMock("../voice/listeners.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../voice/listeners.js")>()),
      DiscordVoiceGuildCreateListener: function DiscordVoiceGuildCreateListener() {},
      DiscordVoiceReadyListener: function DiscordVoiceReadyListener() {},
      DiscordVoiceResumedListener: function DiscordVoiceResumedListener() {},
      DiscordVoiceStateUpdateListener: function DiscordVoiceStateUpdateListener() {},
    }));
    // mock-isolation: Keep media/worker initialization outside provider startup fixtures.
    vi.doMock("../voice/voice-runtime.js", () => {
      voiceRuntimeModuleLoadedMock();
      return {
        DiscordVoiceManager: function DiscordVoiceManager() {
          return { autoJoin: voiceAutoJoinMock };
        },
      };
    });
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  function runProvider(overrides: Partial<Parameters<typeof monitorDiscordProvider>[0]> = {}) {
    return monitorDiscordProvider({
      scheduler: createTestPluginServiceScheduler(),
      config: baseConfig(),
      runtime: baseRuntime(),
      ...overrides,
    });
  }

  it.each(["binding reconciliation", "interaction registration"] as const)(
    "stops thread bindings when %s fails before lifecycle begins",
    async (phase) => {
      const failure = new Error("startup failed");
      if (phase === "binding reconciliation") {
        reconcileAcpThreadBindingsOnStartupMock.mockImplementationOnce(async () => {
          throw failure;
        });
      } else {
        createDiscordNativeCommandMock.mockImplementationOnce(() => {
          throw failure;
        });
      }

      await expect(runProvider()).rejects.toBe(failure);

      expectStoppedBeforeLifecycle();
    },
  );

  it.each([
    ["binding restoration", false],
    ["binding restoration", true],
    ["binding reconciliation", true],
  ] as const)("waits for %s before startup or cancellation (cancel=%s)", async (phase, cancel) => {
    const gate = pause();
    const controller = new AbortController();
    const manager = { stop: vi.fn() };
    createThreadBindingManagerMock.mockImplementationOnce(async () => {
      if (phase === "binding restoration") {
        await gate.wait();
      }
      return manager;
    });
    if (phase === "binding reconciliation") {
      reconcileAcpThreadBindingsOnStartupMock.mockImplementationOnce(async () => {
        await gate.wait();
        return { checked: 0, removed: 0, staleSessionKeys: [] };
      });
    }
    const monitor = runProvider({ abortSignal: controller.signal });
    try {
      await gate.entered;
      if (cancel) {
        controller.abort();
      }
      expect(manager.stop).not.toHaveBeenCalled();
      expect(clientConstructorOptionsMock).not.toHaveBeenCalled();
      expect(monitorLifecycleMock).not.toHaveBeenCalled();
      if (phase === "binding restoration") {
        expect(reconcileAcpThreadBindingsOnStartupMock).not.toHaveBeenCalled();
      }
    } finally {
      gate.release();
      await monitor;
    }
    expect(manager.stop).toHaveBeenCalledTimes(1);
    if (cancel) {
      expect(clientConstructorOptionsMock).not.toHaveBeenCalled();
      expect(monitorLifecycleMock).not.toHaveBeenCalled();
      if (phase === "binding restoration") {
        expect(reconcileAcpThreadBindingsOnStartupMock).not.toHaveBeenCalled();
      }
    } else {
      expect(monitorLifecycleMock).toHaveBeenCalledWith(
        expect.objectContaining({ threadBindings: manager }),
      );
      expect(voiceRuntimeModuleLoadedMock).not.toHaveBeenCalled();
    }
  });

  it("disconnects the shared gateway and keeps a late error guard when startup fails before lifecycle begins", async () => {
    const { disconnect, emitter } = installGateway();
    createDiscordMessageHandlerMock.mockImplementationOnce(() => {
      throw new Error("handler init failed");
    });

    await expect(runProvider()).rejects.toThrow("handler init failed");

    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("error")).toBe(1);
    expect(() =>
      emitter.emit("error", new Error("late gateway error after cleanup")),
    ).not.toThrow();
  });

  it("joins listener and binding work when message-handler cleanup fails", async () => {
    const listener = pause();
    const binding = pause();
    const failure = new Error("message-handler cleanup failed");
    const stop = vi.spyOn(DiscordGuildJoinIntroductionListener.prototype, "stop");
    stop.mockImplementationOnce(async function (this: DiscordGuildJoinIntroductionListener) {
      await listener.wait();
      stop.mockRestore();
      await this.stop();
    });
    const deactivate = vi.fn(async () => {
      expect(stop).toHaveBeenCalledOnce();
      throw failure;
    });
    createDiscordMessageHandlerMock.mockReturnValueOnce(
      Object.assign(
        vi.fn(async () => {}),
        { deactivate },
      ),
    );
    createThreadBindingManagerMock.mockReturnValueOnce({ stop: vi.fn(binding.wait) });
    installGateway(true);
    const settled = vi.fn();
    const monitor = runProvider({
      setStatus: (patch) => {
        if (patch.connected) {
          throw new Error("status publication failed before lifecycle");
        }
      },
    })
      .catch((error: unknown) => error)
      .finally(settled);
    try {
      await listener.entered;
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      listener.release();
      expect(
        await Promise.race([
          binding.entered.then(() => "binding-stop"),
          monitor.then(() => "completed"),
        ]),
      ).toBe("binding-stop");
      expect(settled).not.toHaveBeenCalled();
    } finally {
      listener.release();
      binding.release();
      await monitor;
      stop.mockRestore();
    }
    expect(await monitor).toBe(failure);
    expect(deactivate).toHaveBeenCalledOnce();
    expect(monitorLifecycleMock).not.toHaveBeenCalled();
  });

  it.each(["identity offline", "no usable id"])(
    "fails closed for bot identity: %s",
    async (reason) => {
      const runtime = baseRuntime();
      if (reason === "identity offline") {
        clientFetchUserMock.mockRejectedValueOnce(new Error(reason));
      } else {
        clientFetchUserMock.mockResolvedValueOnce({ username: "Molty" } as never);
      }

      await expect(runProvider({ runtime })).rejects.toThrow(
        "Failed to resolve Discord bot identity",
      );

      expect(createDiscordMessageHandlerMock).not.toHaveBeenCalled();
      expectStoppedBeforeLifecycle();
      expect(mockLog(runtime.error)).toContain(reason);
    },
  );

  it("keeps voice-owned commands out of the generic native dispatcher", async () => {
    const channelRuntime = createPluginRuntimeMock().channel;
    configureAccount({ voice: {} });
    const standard = { name: "normal", description: "Normal", acceptsArgs: false };
    listNativeCommandSpecsForConfigMock.mockReturnValue([
      standard,
      { name: "vc", description: "Shadow voice command", acceptsArgs: false },
    ]);
    const createVoiceCommand = vi.spyOn(voiceCommands, "createDiscordVoiceCommand");
    try {
      await runProvider({ channelRuntime });
      expect(voiceRuntimeModuleLoadedMock).toHaveBeenCalledTimes(1);
      expect(createDiscordNativeCommandMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          command: standard,
          dispatchReplyFromConfig: channelRuntime.reply.dispatchReplyFromConfig,
          buildContext: channelRuntime.inbound.buildContext,
        }),
      );
      expect(createVoiceCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ accountId: "default", getManager: expect.any(Function) }),
      );
    } finally {
      createVoiceCommand.mockRestore();
    }
  });

  it("registers the native approval runtime context when exec approvals are enabled", async () => {
    const channelRuntime = createPluginRuntimeMock().channel;
    const execApprovalsConfig = { enabled: true, approvers: ["123"] };
    configureAccount({ execApprovals: execApprovalsConfig }, "cfg-token");

    await runProvider({ channelRuntime });

    expect(
      channelRuntime.runtimeContexts.get({
        channelId: "discord",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({
      token: "cfg-token",
      config: execApprovalsConfig,
    });
  });

  it.each([
    ["error status", { state: "error" }, "uncertain", "status-error-state"],
    [
      "typed init failure",
      createAcpRuntimeError("ACP_SESSION_INIT_FAILED", "missing ACP metadata"),
      "stale",
      "session-init-failed",
    ],
    [
      "typed backend failure",
      createAcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "runtime unavailable"),
      "uncertain",
      "status-error",
    ],
    [
      "legacy missing session",
      new Error("ACP session metadata missing"),
      "stale",
      "session-missing",
    ],
  ] as const)(
    "classifies ACP %s during startup reconciliation",
    async (_name, result, status, reason) => {
      if (result instanceof Error) {
        getAcpSessionStatusMock.mockRejectedValue(result);
      } else {
        getAcpSessionStatusMock.mockResolvedValue(result);
      }
      await runProvider();
      await expect(probe("probe")).resolves.toEqual({ status, reason });
    },
  );

  it.each([
    ["idle", 600_000, "uncertain", "status-timeout"],
    ["running", Number.MAX_SAFE_INTEGER, "stale", "status-timeout-running-stale"],
  ] as const)("aborts a timed-out %s ACP probe", async (state, lastActivityAt, status, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(600_000);
    try {
      getAcpSessionStatusMock.mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );
      await runProvider();
      const pending = probe("timeout", state, lastActivityAt);
      await vi.advanceTimersByTimeAsync(8_100);
      await expect(pending).resolves.toEqual({ status, reason });
      expect(getAcpSessionStatusMock.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a nested incognito refusal instead of marking a running session stale", async () => {
    const error = new AggregateError(
      [new IncognitoSessionSyncAccessError("resolveSession", "resolveSessionAsync")],
      "ACP status failed",
    );
    getAcpSessionStatusMock.mockRejectedValue(error);
    await runProvider();
    await expect(probe("refused", "running", 0)).rejects.toBe(error);
  });

  it("captures gateway errors emitted before lifecycle wait starts", async () => {
    const { emitter } = installGateway();
    const drained: Array<{ message: string; type: string }> = [];
    monitorLifecycleMock.mockImplementationOnce(async (params) => {
      (params as Parameters<typeof runDiscordGatewayLifecycle>[0]).gatewaySupervisor?.drainPending(
        (event) => {
          drained.push(event);
          return "continue";
        },
      );
      params.threadBindings.stop();
    });
    clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("error", new Error("Fatal gateway close code: 4014"));
      return { id: "bot-1" };
    });

    await runProvider();

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(drained).toEqual([
      expect.objectContaining({
        type: "disallowed-intents",
        message: expect.stringContaining("4014"),
      }),
    ]);
  });

  it.each(["quota", "abort", "rate-limit"] as const)(
    "continues startup after command deploy %s",
    async (kind) => {
      const runtime = baseRuntime();
      const error =
        kind === "abort"
          ? new Error("This operation was aborted")
          : new RateLimitError(
              new Response(null, {
                status: 429,
                ...(kind === "quota"
                  ? {
                      headers: {
                        "X-RateLimit-Scope": "shared",
                        "X-RateLimit-Bucket": "bucket-1",
                      },
                    }
                  : {}),
              }),
              {
                message:
                  kind === "quota"
                    ? "Max number of daily application command creates has been reached (200)"
                    : "You are being rate limited.",
                retry_after: kind === "quota" ? 193.632 : 0,
                global: false,
                ...(kind === "quota" ? { code: 30034 } : {}),
              },
            );
      if (kind === "rate-limit") {
        clientDeployCommandsMock.mockRejectedValue(error);
      } else {
        clientDeployCommandsMock.mockRejectedValueOnce(error);
      }
      await runProvider({ runtime });
      await vi.waitFor(() => expect(clientDeployCommandsMock).toHaveBeenCalledTimes(1));
      expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
      if (kind === "quota") {
        expect(clientFetchUserMock).toHaveBeenCalledWith("@me");
      } else if (kind === "abort") {
        expect(mockLog(runtime.error)).not.toContain("failed to deploy native commands");
        expect(mockLog(runtime.log)).toContain(
          "slash command deploy failed (message send/receive unaffected): Discord REST request was aborted",
        );
      } else {
        const warnings = mockLog(runtime.log)
          .split("\n")
          .filter((message) => message.includes("slash command deploy rate limited"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("retry after 0s");
        expect(warnings[0]).toContain("Message send/receive is unaffected.");
        expect(warnings[0]).not.toContain("body=");
        expect(mockLog(runtime.error)).not.toContain("native-slash-command-deploy-rest");
      }
    },
  );

  it("uses the native REST retry fallback for malformed Discord retry_after values", async () => {
    const rest = new RequestClient("synthetic-token", {
      queueRequests: false,
      fetch: async () =>
        Response.json(
          {
            message: "You are being rate limited.",
            retry_after: "0x2",
            global: false,
          },
          { status: 429 },
        ),
    });
    await expect(
      rest
        .get("/applications/app-1/commands")
        .catch((error: unknown) => formatDiscordDeployErrorDetails(error)),
    ).resolves.toBe(" (status=429, retryAfter=1s, scope=route)");
  });

  it("keeps truncated Discord deploy response bodies UTF-16 safe", () => {
    const prefix = "a".repeat(798);
    const details = formatDiscordDeployErrorDetails({
      rawBody: `${prefix}😀tail`,
    });

    expect(details).toBe(` (body="${prefix}...)`);
  });

  it("formats rejected Discord deploy entries with command details", () => {
    const details = formatDiscordDeployErrorDetails({
      status: 400,
      discordCode: 50035,
      rawBody: {
        errors: Object.fromEntries([63, 65, 66, 67].map((index) => [index, { description: {} }])),
      },
      deployRequestBody: Array.from({ length: 68 }, (_entry, index) => ({
        name: `command-${index}`,
        description: `description-${index}`,
      })),
    });

    expect(details).toContain("status=400, code=50035, body=");
    expect(details).toContain("rejected=");
    for (const index of [63, 65, 66]) {
      expect(details).toContain(
        `#${index} fields=description name=command-${index} description="description-${index}"`,
      );
    }
    expect(details).not.toContain("command-67");
  });

  it("skips slash-command lifecycle REST when native commands are disabled", async () => {
    const runtime = baseRuntime();
    isNativeCommandsExplicitlyDisabledMock.mockReturnValue(true);
    resolveNativeCommandsEnabledMock.mockReturnValue(false);
    configureAccount({
      applicationId: "987654321098765432",
      commands: { native: false, nativeSkills: false },
    });

    await runProvider({ runtime });

    expect(listNativeCommandSpecsForConfigMock).not.toHaveBeenCalled();
    expect(clientDeployCommandsMock).not.toHaveBeenCalled();
    expect(mockLog(runtime.log)).not.toContain("cleared native commands");
  });

  it.each([
    ["blocked", { kind: "rejected", status: 401, error: new Error("Unauthorized") }, true],
    [
      "recovering",
      { kind: "unavailable", status: null, error: new Error("fetch failed") },
      undefined,
    ],
  ] as const)(
    "publishes %s for an application-id failure before gateway startup",
    async (lifecycle, result, terminalDisconnect) => {
      const setStatus = vi.fn();
      probeDiscordApplicationIdMock.mockResolvedValueOnce(result);
      configureAccount({}, "unparseable.token");

      await expect(runProvider({ setStatus })).rejects.toThrow(
        "Failed to resolve Discord application id",
      );

      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          connected: false,
          lifecycle,
          terminalDisconnect,
          lastDisconnect:
            result.status === null
              ? expect.not.objectContaining({ status: expect.anything() })
              : expect.objectContaining({ status: result.status }),
        }),
      );
      expect(clientConstructorOptionsMock).not.toHaveBeenCalled();
      expect(monitorLifecycleMock).not.toHaveBeenCalled();
    },
  );

  it("publishes ready and disconnected status across the gateway lifecycle", async () => {
    installGateway(true);
    const setStatus = vi.fn();

    await runProvider({ setStatus });

    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true, lifecycle: "ready" }),
    );
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ connected: false }));
  });
});
