import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../channel.js";
import { assertSlackDetachedTargetAllowed } from "../detached-target-admission.js";
import { getSlackInstallationKind } from "../installation-identity-state.js";
import {
  disposeSlackTestRuntime,
  flush,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  PROXY_ENV_KEYS,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
  SLACK_TEST_STARTUP_AUTH_TIMEOUT_MS,
  startSlackMonitor as startSlackMonitorUntracked,
  stopSlackMonitor,
  stopSlackTestDispatches,
  useShortSlackStartupAuthClientOnce,
  useSlackStartupAuthClientOnce,
  waitForSlackTestApp,
} from "../monitor.test-helpers.js";
import { getSlackRuntime } from "../runtime.js";
import { startStalledSlackApiServer } from "./provider.stalled-api.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");

type StartedSlackMonitor = ReturnType<typeof startSlackMonitorUntracked>;

const startedMonitors: StartedSlackMonitor[] = [];

function trackSlackMonitor<T extends StartedSlackMonitor>(monitor: T): T {
  startedMonitors.push(monitor);
  return monitor;
}

function startSlackMonitor(...args: Parameters<typeof startSlackMonitorUntracked>) {
  return trackSlackMonitor(startSlackMonitorUntracked(...args));
}

async function runTrackedSlackMessageOnce(
  provider: Parameters<typeof startSlackMonitorUntracked>[0],
  args: unknown,
  opts?: Parameters<typeof startSlackMonitorUntracked>[1],
) {
  const monitor = startSlackMonitor(provider, opts);
  try {
    const handler = await getSlackHandlerOrThrow("message");
    await runSlackHandlerWithDispatch(handler, args);
  } finally {
    await stopSlackMonitor(monitor);
  }
}

function configureSlack(slack: SlackAccountConfig) {
  return resetSlackTestState({ channels: { slack } });
}

beforeEach(async () => {
  await resetSlackTestState();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
  );
});

afterEach(async () => {
  const monitors = startedMonitors.splice(0);
  for (const monitor of monitors) {
    monitor.controller.abort();
  }
  await Promise.allSettled([stopSlackTestDispatches(), ...monitors.map((monitor) => monitor.run)]);
  try {
    getSlackClient().auth.test.mockReset();
    await resetSlackTestState();
  } finally {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  }
});

afterAll(disposeSlackTestRuntime);

describe("auth.test boot call", () => {
  it("omits the empty body on the shipped Socket Mode startup path", async () => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    const actualClient = await vi.importActual<typeof import("../client.js")>("../client.js");
    useSlackStartupAuthClientOnce(actualClient.createSlackStartupAuthClient);
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        bot_id: "BBOT",
        is_enterprise_install: false,
        ok: true,
        team_id: "T1",
        user_id: "UBOT",
      }),
    );
    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      await stopSlackMonitor(monitor);

      expect(globalFetch).toHaveBeenCalledOnce();
      expect(globalFetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
      expect(globalFetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("does not use a user-token identity as the bot mention target", async () => {
    await configureSlack({
      groupPolicy: "open",
      channels: { C1: { enabled: true, requireMention: true } },
    });
    const client = getSlackClient();
    client.auth.test.mockResolvedValue({
      app_id: "A1",
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T1",
      team: "OpenClaw",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "unexpected" });

    await runTrackedSlackMessageOnce(
      monitorSlackProvider,
      {
        event: {
          type: "message",
          user: "USENDER",
          text: "<@UUSER> status",
          ts: "100.000",
          channel: "C1",
          channel_type: "channel",
        },
      },
      { botToken: "xoxp-user-token" },
    );

    expect(replyMock).not.toHaveBeenCalled();
  });

  describe("stalled startup auth", () => {
    // Schema setup belongs to the fixture, outside the transport's deadline proof.
    beforeEach(() => void openOpenClawStateDatabase());

    it("settles and closes a real stalled startup auth request before degraded startup", async (context) => {
      const run = (async () => {
        const events: string[] = [];
        for (const key of PROXY_ENV_KEYS) {
          vi.stubEnv(key, "");
        }
        const server = await startStalledSlackApiServer(events);
        vi.stubEnv("SLACK_API_URL", server.apiUrl);
        useShortSlackStartupAuthClientOnce();
        const finished = new AbortController();
        const signal = AbortSignal.any([context.signal, finished.signal]);
        const aborted = waitForAbortSignal(signal).then(() => signal.throwIfAborted());
        // Cancellation can precede the first request wait during setup.
        void aborted.catch(() => {});
        const deadlines: AbortController[] = [];
        const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
        // The SDK uses AbortSignal.timeout, which Vitest's timer clock cannot advance.
        const timeoutClock = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
          if (delay !== SLACK_TEST_STARTUP_AUTH_TIMEOUT_MS) {
            return nativeTimeout(delay);
          }
          const deadline = new AbortController();
          deadlines.push(deadline);
          return AbortSignal.any([deadline.signal, signal]);
        });

        const runtimeLog = vi.fn((...args: unknown[]) => {
          const message = args[0];
          if (typeof message === "string" && message.includes("slack auth.test failed at boot")) {
            events.push("auth-settled");
          }
        });
        const { appStartMock } = getSlackTestState();
        appStartMock.mockImplementationOnce(async () => {
          events.push("app-start");
        });
        const monitor = startSlackMonitor(monitorSlackProvider, {
          runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
        });
        try {
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            await Promise.race([server.waitForRequest(attempt), aborted]);
            expect(deadlines).toHaveLength(attempt);
            deadlines[attempt - 1]!.abort(
              new DOMException("The operation was aborted due to timeout", "TimeoutError"),
            );
          }
          await Promise.race([waitForSlackTestApp(monitor, "started"), aborted]);
          expect(appStartMock).toHaveBeenCalledTimes(1);
          await Promise.race([
            Promise.all([1, 2, 3].map((attempt) => server.waitForRequestClose(attempt))),
            aborted,
          ]);
          expect(events.filter((event) => event === "socket-closed")).toHaveLength(3);

          expect(server.requestCount).toBe(3);
          expect(server.requestUrl).toBe("/api/auth.test");
          expect(events).toContain("auth-settled");
          expect(events.indexOf("auth-settled")).toBeLessThan(events.indexOf("app-start"));
          expect(runtimeLog).toHaveBeenCalledWith(
            expect.stringMatching(/slack auth\.test failed at boot .*(?:timeout|timed out)/i),
          );
        } finally {
          finished.abort();
          timeoutClock.mockRestore();
          for (const deadline of deadlines) {
            deadline.abort();
          }
          monitor.controller.abort();
          await server.close();
          await monitor.run;
        }
      })();
      context.onTestFinished(() => run);
      await run;
    }, 5_000);
  });
});

describe("presence polling transport", () => {
  it("aborts a stalled presence request when the provider stops", async () => {
    const events: string[] = [];
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    const server = await startStalledSlackApiServer(events);
    vi.stubEnv("SLACK_API_URL", server.apiUrl);
    await configureSlack({
      dm: { enabled: true },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      presenceEvents: { mode: "on" },
    });
    getSlackRuntime().state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("slack", {
        ...options,
        env: options.env ?? process.env,
      });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "ok" });

    const clock = createGatewaySchedulerClock();
    const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
    const monitor = startSlackMonitor((options) => monitorSlackProvider({ ...options, scheduler }));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await runSlackHandlerWithDispatch(handler, {
        event: {
          type: "message",
          user: "U_STALLED",
          text: "hello",
          ts: "100.000",
          channel: "D_STALLED",
          channel_type: "im",
        },
        context: { botUserId: "bot-user" },
        body: {},
      });
      const dispatchedContext = replyMock.mock.calls[0]?.[0];
      expect(dispatchedContext).toMatchObject({
        Body: expect.stringMatching(
          /Ada: hello\n\[slack message id: 100\.000 channel: D_STALLED\]$/u,
        ),
        ChatType: "direct",
        WasMentioned: false,
      });
      expect(sendMock).toHaveBeenCalledWith("channel:D_STALLED", "ok", expect.any(Object));
      expect(clock.armedAtMs).toBe(60_000);
      void clock.wake();
      await vi.waitFor(() => expect(server.requestCount).toBe(1), { timeout: 1_000 });

      const startedAt = Date.now();
      monitor.controller.abort();
      const outcome = await Promise.race([
        monitor.run.then(() => "settled" as const),
        new Promise<"timed-out">((resolve) => {
          deadline = setTimeout(() => resolve("timed-out"), 2_000);
        }),
      ]);

      expect(outcome).toBe("settled");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await vi.waitFor(() => expect(events).toContain("socket-closed"), { timeout: 1_000 });
      expect(server.requestUrl).toBe("/api/users.getPresence");
      expect(clock.armedAtMs).toBeNull();
      await clock.advanceBy(60_000);
      expect(server.requestCount).toBe(1);
    } finally {
      clearTimeout(deadline);
      monitor.controller.abort();
      await server.close();
      await monitor.run;
      await scheduler.stop();
    }
  });
});

describe("user identity provider transport", () => {
  const userSocketConfig = () =>
    ({
      channels: {
        slack: {
          postAs: "user",
          userToken: "test-user-token",
          appToken: "test-app-token",
          dm: { enabled: true },
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
        },
      },
    }) satisfies OpenClawConfig;

  async function startWithoutBotToken(config: OpenClawConfig) {
    const controller = new AbortController();
    const run = monitorSlackProvider({
      scheduler: createTestPluginServiceScheduler(),
      config,
      abortSignal: controller.signal,
    });
    const monitor = trackSlackMonitor({ controller, run });
    await waitForSlackTestApp(monitor, "constructed");
    expect(getSlackTestState().appConstructorArgs).toBeDefined();
    return monitor;
  }

  it("uses the authenticated human id as the mention target", async () => {
    const config = {
      channels: {
        slack: {
          ...userSocketConfig().channels.slack,
          channels: { C1: { enabled: true, requireMention: true } },
        },
      },
    };
    await resetSlackTestState(config);
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      app_id: "A_TEST",
      user_id: "U_SELF",
      team_id: "T_TEST",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "acknowledged" });
    const monitor = await startWithoutBotToken(config);
    expect(getSlackTestState().appConstructorArgs).toMatchObject({
      token: "test-user-token",
      tokenVerificationEnabled: false,
    });
    expect(getSlackTestState().createSlackStartupAuthClientMock).toHaveBeenCalledWith(
      "test-user-token",
      expect.any(Object),
    );
    const handler = await getSlackHandlerOrThrow("message");

    await runSlackHandlerWithDispatch(handler, {
      event: {
        type: "message",
        user: "U_OTHER",
        text: "<@U_SELF> status",
        ts: "100.000",
        channel: "C1",
        channel_type: "channel",
      },
      context: { botUserId: "U_SELF" },
      body: {},
    });

    const dispatchedContext = replyMock.mock.calls[0]?.[0];
    expect(dispatchedContext).toMatchObject({
      Body: expect.stringMatching(/<@U_SELF>.*status/u),
      ChatType: "channel",
      WasMentioned: true,
    });
    expect(sendMock).toHaveBeenCalledWith("channel:C1", "acknowledged", expect.any(Object));
    await stopSlackMonitor(monitor);
  });

  it("delivers another user's DM and drops a self-authored DM", async () => {
    const config = userSocketConfig();
    await resetSlackTestState(config);
    getSlackClient().auth.test.mockResolvedValueOnce({
      app_id: "A_TEST",
      user_id: "U_SELF",
      team_id: "T_TEST",
      is_enterprise_install: false,
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "hello back" });
    const monitor = await startWithoutBotToken(config);
    const handler = await getSlackHandlerOrThrow("message");
    const baseEvent = {
      type: "message",
      channel: "D1",
      channel_type: "im",
      text: "hello",
    };

    await runSlackHandlerWithDispatch(handler, {
      event: { ...baseEvent, user: "U_OTHER", ts: "100.000" },
      context: { botUserId: "U_SELF" },
      body: {},
    });
    const dispatchedContext = replyMock.mock.calls[0]?.[0];
    expect(dispatchedContext).toMatchObject({
      Body: expect.stringMatching(/Ada: hello\n\[slack message id: 100\.000 channel: D1\]$/u),
      ChatType: "direct",
      WasMentioned: false,
    });
    expect(sendMock).toHaveBeenCalledWith("channel:D1", "hello back", expect.any(Object));

    await handler({
      event: { ...baseEvent, user: "U_SELF", ts: "101.000" },
      context: { botUserId: "U_SELF" },
      body: {},
    });
    await flush();

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    await stopSlackMonitor(monitor);
  });

  it.each([
    {
      config: { appToken: "test-app-token" },
      error: 'Slack user token missing for account "default"',
    },
    {
      config: { userToken: "test-user-token" },
      error: 'Slack app token missing for user-identity socket mode account "default"',
    },
    {
      config: { mode: "http", userToken: "test-user-token" },
      error: 'Slack signing secret missing for user-identity HTTP mode account "default"',
    },
  ] as const)("rejects missing user-identity credentials: $error", async ({ config, error }) => {
    vi.stubEnv("SLACK_USER_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    await expect(
      monitorSlackProvider({
        scheduler: createTestPluginServiceScheduler(),
        config: { channels: { slack: { postAs: "user", ...config } } },
      }),
    ).rejects.toThrow(error);
  });
});

describe("connected identity health", () => {
  it("blocks an Enterprise identity without a bot user", async () => {
    await resetSlackTestState({
      channels: { slack: { dmPolicy: "disabled", groupPolicy: "open" } },
    });
    getSlackClient().auth.test.mockResolvedValue({
      enterprise_id: "E1",
      is_enterprise_install: true,
    });
    const setStatus = vi.fn();
    await stopSlackMonitor(startSlackMonitor(monitorSlackProvider, { setStatus }));
    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: true,
      lifecycle: "blocked",
      lastError: "auth.test returned no user_id",
    });
  });

  it("fails closed until auth.test recovery establishes a workspace install", async () => {
    const client = getSlackClient();
    const workspaceAuth = {
      app_id: "A_WORKSPACE",
      user_id: "UWORKSPACE",
      bot_id: "BWORKSPACE",
      team_id: "T_WORKSPACE",
      is_enterprise_install: false,
    };
    const recoveredAuth = createDeferred<typeof workspaceAuth>();
    const recoveryStarted = createDeferred<void>();
    const ready = createDeferred<void>();
    client.auth.test
      .mockRejectedValueOnce(new Error("request_timeout"))
      .mockImplementationOnce(() => {
        recoveryStarted.resolve();
        return recoveredAuth.promise;
      });
    const setStatus = vi.fn((next: Record<string, unknown>) => {
      if (next.lifecycle === "ready") {
        ready.resolve();
      }
    });

    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });
    try {
      await Promise.race([recoveryStarted.promise, monitor.run]);
      expect(getSlackInstallationKind("default")).toBe("degraded");
      expect(() => assertSlackDetachedTargetAllowed("default")).toThrow(
        "unsupported_enterprise_slack_delivery",
      );
      expect(() => assertSlackDetachedTargetAllowed("default", "T_RECOVERED")).not.toThrow();

      recoveredAuth.resolve(workspaceAuth);
      await Promise.race([ready.promise, monitor.run]);
      expect(getSlackInstallationKind("default")).toBe("workspace");
      expect(client.auth.test).toHaveBeenCalledTimes(2);
      expect(() => assertSlackDetachedTargetAllowed("default")).not.toThrow();
    } finally {
      // Aborting the monitor cannot settle a test-owned auth request after an assertion fails.
      recoveredAuth.resolve(workspaceAuth);
      await stopSlackMonitor(monitor);
    }

    expect(setStatus).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: undefined,
      lifecycle: "ready",
      lastError: null,
    });
    expect(getSlackInstallationKind("default")).toBeUndefined();
    expect(() => assertSlackDetachedTargetAllowed("default")).not.toThrow();
  });

  it("recovers Enterprise identity without app_id and dispatches with the app-token scope", async () => {
    await configureSlack({
      dmPolicy: "disabled",
      groupPolicy: "open",
      slashCommand: { enabled: true, name: "openclaw" },
      channels: {
        "team:TWORKSPACE:channel:C12345678": { enabled: true, requireMention: true },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockRejectedValueOnce(new Error("request_timeout")).mockResolvedValue({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E_ENTERPRISE",
      is_enterprise_install: true,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock, sendMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "identity restored" });
    const setStatus = vi.fn();
    const monitor = startSlackMonitor(monitorSlackProvider, {
      setStatus,
      appToken: "xapp-1-AENTERPRISE-opaque",
    });
    const handler = await getSlackHandlerOrThrow("message");

    await vi.waitFor(() => expect(getSlackInstallationKind("default")).toBe("enterprise"));
    expect(client.auth.test).toHaveBeenCalledTimes(2);
    expect([...getSlackTestState().interactionRegistrations].toSorted()).toEqual([
      "action",
      "command",
      "shortcut",
      "view",
      "view",
    ]);
    expect(() => assertSlackDetachedTargetAllowed("default")).toThrow(
      "unsupported_enterprise_slack_delivery",
    );
    expect(() => assertSlackDetachedTargetAllowed("default", "TWORKSPACE")).not.toThrow();
    expect(setStatus).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: undefined,
      lifecycle: "ready",
      lastError: null,
    });
    expect(getSlackHandlers().has("reaction_added")).toBe(true);

    await runSlackHandlerWithDispatch(handler, {
      event: {
        type: "message",
        user: "UOTHER123",
        text: "<@UENTERPRISE> status",
        ts: "999999.123",
        channel: "C12345678",
        channel_type: "channel",
      },
      context: {
        isEnterpriseInstall: true,
        enterpriseId: "E_ENTERPRISE",
        teamId: "TWORKSPACE",
      },
      body: { api_app_id: "AENTERPRISE" },
      client,
    });

    expect(client.conversations.info).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C12345678" }),
    );
    expect(replyMock).toHaveBeenCalledTimes(1);
    const dispatchedContext = replyMock.mock.calls[0]?.[0];
    expect(dispatchedContext).toMatchObject({
      Body: expect.stringMatching(/<@UENTERPRISE>.*status/u),
      ChatType: "channel",
      WasMentioned: true,
    });
    expect(sendMock).toHaveBeenCalledWith(
      "channel:C12345678",
      "identity restored",
      expect.objectContaining({
        eventScope: expect.objectContaining({ teamId: "TWORKSPACE", client }),
      }),
    );
    await stopSlackMonitor(monitor);
  });

  it("validates Enterprise policy before promoting recovered identity", async () => {
    await resetSlackTestState({ channels: { slack: { dangerouslyAllowNameMatching: true } } });
    const client = getSlackClient();
    client.auth.test.mockRejectedValueOnce(new Error("request_timeout")).mockResolvedValue({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E_ENTERPRISE",
      is_enterprise_install: true,
    });
    const setStatus = vi.fn();
    const monitor = startSlackMonitor(monitorSlackProvider, { setStatus });

    await vi.waitFor(() => expect(client.auth.test).toHaveBeenCalledTimes(2));
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: true,
        lifecycle: "blocked",
        lastError: expect.stringMatching(/cannot use dangerouslyAllowNameMatching/),
      }),
    );
    expect(getSlackHandlers().has("reaction_added")).toBe(true);
    await stopSlackMonitor(monitor);
  });
});
