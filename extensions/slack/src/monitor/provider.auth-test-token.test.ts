import { createRequire } from "node:module";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
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
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../channel.js";
import { assertSlackDetachedTargetAllowed } from "../detached-target-admission.js";
import {
  getSlackInstallationKind,
  getSlackInstallationTeamId,
} from "../installation-identity-state.js";
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
import { getSlackRuntime, setSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";
import { startStalledSlackApiServer } from "./provider.stalled-api.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");
const client = getSlackClient();
const state = getSlackTestState();
const { replyMock, sendMock, appStopMock, resolveSlackUserAllowlistMock } = state;
const generalChannel = { channel: { name: "general", is_channel: true } };
const userAuth = {
  app_id: "A_TEST",
  user_id: "U_SELF",
  team_id: "T_TEST",
  is_enterprise_install: false,
};

type StartedSlackMonitor = ReturnType<typeof startSlackMonitorUntracked>;

const startedMonitors: StartedSlackMonitor[] = [];

function trackSlackMonitor<T extends StartedSlackMonitor>(monitor: T): T {
  startedMonitors.push(monitor);
  return monitor;
}

function startSlackMonitor(...args: Parameters<typeof startSlackMonitorUntracked>) {
  return trackSlackMonitor(startSlackMonitorUntracked(...args));
}

function messageEvent(
  user: string,
  text: string,
  ts: string,
  channel: string,
  channel_type: "im" | "channel",
) {
  return { type: "message", user, text, ts, channel, channel_type } satisfies SlackMessageEvent;
}

function clearProxyEnv(value = "") {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, value);
  }
}

const enterpriseAuth = {
  user_id: "UENTERPRISE",
  bot_id: "BENTERPRISE",
  enterprise_id: "E_ENTERPRISE",
  is_enterprise_install: true,
};

function expectReadyStatus(setStatus: ReturnType<typeof vi.fn>) {
  expect(setStatus).toHaveBeenCalledWith({
    running: true,
    connected: true,
    lastConnectedAt: expect.any(Number),
    terminalDisconnect: undefined,
    lifecycle: "ready",
    lastError: null,
  });
}

function expectBlockedStatus(
  setStatus: ReturnType<typeof vi.fn>,
  lastError: string,
  connected = true,
) {
  expect(setStatus).toHaveBeenCalledWith({
    connected,
    ...(connected ? { lastConnectedAt: expect.any(Number) } : {}),
    terminalDisconnect: true,
    lifecycle: "blocked",
    lastError,
  });
}

function configureSlack(slack: SlackAccountConfig) {
  return resetSlackTestState({ channels: { slack } });
}

function expectDispatchedContext(
  body: RegExp,
  ChatType: "direct" | "channel",
  WasMentioned: boolean,
) {
  expect(replyMock.mock.calls[0]?.[0]).toMatchObject({
    Body: expect.stringMatching(body),
    ChatType,
    WasMentioned,
  });
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
    client.auth.test.mockReset();
    await resetSlackTestState();
  } finally {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  }
});

afterAll(disposeSlackTestRuntime);

describe("auth.test boot call", () => {
  it("hands Socket Mode a dispatcher from its own undici copy", async () => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.com:3128");
    const requireFromTest = createRequire(import.meta.url);
    const requireFromBolt = createRequire(requireFromTest.resolve("@slack/bolt/package.json"));
    const requireFromSocketMode = createRequire(
      requireFromBolt.resolve("@slack/socket-mode/package.json"),
    );
    const { EnvHttpProxyAgent } = requireFromSocketMode(
      "undici/index.js",
    ) as typeof import("undici");
    await withMonitor(async () => {
      await getSlackHandlerOrThrow("message");
      expect(state.socketModeReceiverArgs?.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    });
  });

  it("omits the empty body on the shipped Socket Mode startup path", async () => {
    clearProxyEnv();
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
    client.auth.test.mockResolvedValue({
      app_id: "A1",
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T1",
      team: "OpenClaw",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce(generalChannel);
    replyMock.mockResolvedValue({ text: "unexpected" });

    const monitor = startSlackMonitor(monitorSlackProvider, { botToken: "xoxp-user-token" });
    await runSlackHandlerWithDispatch(await getSlackHandlerOrThrow("message"), {
      event: messageEvent("USENDER", "<@UUSER> status", "100.000", "C1", "channel"),
    });
    await stopSlackMonitor(monitor);
    expect(replyMock).not.toHaveBeenCalled();
  });

  describe("stalled startup auth", () => {
    // Schema setup belongs to the fixture, outside the transport's deadline proof.
    beforeEach(() => void openOpenClawStateDatabase());

    it("settles and closes a real stalled startup auth request before degraded startup", async (context) => {
      const run = (async () => {
        const events: string[] = [];
        clearProxyEnv();
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
        const { appStartMock } = state;
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
    clearProxyEnv();
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
    replyMock.mockResolvedValue({ text: "ok" });

    const clock = createGatewaySchedulerClock();
    const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
    const monitor = startSlackMonitor((options) => monitorSlackProvider({ ...options, scheduler }));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await runSlackHandlerWithDispatch(handler, {
        event: messageEvent("U_STALLED", "hello", "100.000", "D_STALLED", "im"),
        context: { botUserId: "bot-user" },
        body: {},
      });
      expectDispatchedContext(
        /Ada: hello\n\[slack message id: 100\.000 channel: D_STALLED\]$/u,
        "direct",
        false,
      );
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
  const userSocketConfig = (overrides: SlackAccountConfig = {}) =>
    slackConfig({
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
      dm: { enabled: true },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      ...overrides,
    });

  async function startWithoutBotToken(config: OpenClawConfig) {
    const controller = new AbortController();
    const run = monitorSlackProvider({
      scheduler: createTestPluginServiceScheduler(),
      config,
      abortSignal: controller.signal,
    });
    const monitor = trackSlackMonitor({ controller, run });
    await waitForSlackTestApp(monitor, "constructed");
    expect(state.appConstructorArgs).toBeDefined();
    return monitor;
  }

  it("uses the authenticated human id as the mention target", async () => {
    const config = userSocketConfig({ channels: { C1: { enabled: true, requireMention: true } } });
    await resetSlackTestState(config);
    client.auth.test.mockResolvedValueOnce(userAuth);
    client.conversations.info.mockResolvedValueOnce(generalChannel);
    replyMock.mockResolvedValue({ text: "acknowledged" });
    const monitor = await startWithoutBotToken(config);
    expect(state.appConstructorArgs).toMatchObject({
      token: "test-user-token",
      tokenVerificationEnabled: false,
    });
    expect(state.createSlackStartupAuthClientMock).toHaveBeenCalledWith(
      "test-user-token",
      expect.any(Object),
    );
    const handler = await getSlackHandlerOrThrow("message");

    await runSlackHandlerWithDispatch(handler, {
      event: messageEvent("U_OTHER", "<@U_SELF> status", "100.000", "C1", "channel"),
      context: { botUserId: "U_SELF" },
      body: {},
    });

    expectDispatchedContext(/<@U_SELF>.*status/u, "channel", true);
    expect(sendMock).toHaveBeenCalledWith("channel:C1", "acknowledged", expect.any(Object));
    await stopSlackMonitor(monitor);
  });

  it("delivers another user's DM and drops a self-authored DM", async () => {
    const config = userSocketConfig();
    await resetSlackTestState(config);
    client.auth.test.mockResolvedValueOnce(userAuth);
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
    expectDispatchedContext(
      /Ada: hello\n\[slack message id: 100\.000 channel: D1\]$/u,
      "direct",
      false,
    );
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
    await configureSlack({ dmPolicy: "disabled", groupPolicy: "open" });
    getSlackClient().auth.test.mockResolvedValue({
      enterprise_id: "E1",
      is_enterprise_install: true,
    });
    const setStatus = vi.fn();
    await stopSlackMonitor(startSlackMonitor(monitorSlackProvider, { setStatus }));
    expectBlockedStatus(setStatus, "auth.test returned no user_id");
  });

  it("fails closed until auth.test recovery establishes a workspace install", async () => {
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

    expectReadyStatus(setStatus);
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
    client.auth.test
      .mockRejectedValueOnce(new Error("request_timeout"))
      .mockResolvedValue(enterpriseAuth);
    client.conversations.info.mockResolvedValueOnce(generalChannel);
    replyMock.mockResolvedValue({ text: "identity restored" });
    const setStatus = vi.fn();
    const monitor = startSlackMonitor(monitorSlackProvider, {
      setStatus,
      appToken: "xapp-1-AENTERPRISE-opaque",
    });
    const handler = await getSlackHandlerOrThrow("message");

    await vi.waitFor(() => expect(getSlackInstallationKind("default")).toBe("enterprise"));
    expect(client.auth.test).toHaveBeenCalledTimes(2);
    expect([...state.interactionRegistrations].toSorted()).toEqual([
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
    expectReadyStatus(setStatus);
    expect(getSlackHandlers().has("reaction_added")).toBe(true);

    await runSlackHandlerWithDispatch(handler, {
      event: messageEvent(
        "UOTHER123",
        "<@UENTERPRISE> status",
        "999999.123",
        "C12345678",
        "channel",
      ),
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
    expectDispatchedContext(/<@UENTERPRISE>.*status/u, "channel", true);
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
    await configureSlack({ dangerouslyAllowNameMatching: true });
    client.auth.test
      .mockRejectedValueOnce(new Error("request_timeout"))
      .mockResolvedValue(enterpriseAuth);
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

describe("auth.test event identity recovery", () => {
  const setStatus = vi.fn();
  const workspaceContext = {
    botUserId: "URECOVERED",
    botId: "BRECOVERED",
    teamId: "T12345678",
    isEnterpriseInstall: false,
  };
  const httpConfig = {
    mode: "http",
    signingSecret: "test-signing-secret",
    groupPolicy: "open",
    requireMention: true,
  } as const;

  async function start(appToken?: string) {
    const monitor = startSlackMonitor(monitorSlackProvider, { appToken, setStatus });
    if (appToken) {
      await waitForSlackTestApp(monitor, "started");
    }
    return getSlackHandlerOrThrow("message");
  }

  function message(ts: string, apiAppId: string) {
    return {
      event: messageEvent("U_OTHER", "<@URECOVERED> status", ts, "C12345678", "channel"),
      context: workspaceContext,
      body: { api_app_id: apiAppId, team_id: workspaceContext.teamId },
    };
  }

  async function reset(slack: Record<string, unknown> = httpConfig) {
    await resetSlackTestState({ channels: { slack } });
    client.conversations.info.mockResolvedValueOnce(generalChannel);
    state.replyMock.mockResolvedValue({ text: "identity restored" });
  }
  beforeEach(async () => {
    setStatus.mockReset();
    await reset();
  });
  it("keeps the app-token app id when a signed event carries another", async () => {
    const appToken = "xapp-1-A0TOKEN-1-secret";
    await reset({ mode: "socket", appToken, groupPolicy: "open", requireMention: true });
    client.auth.test.mockResolvedValue({
      user_id: workspaceContext.botUserId,
      bot_id: workspaceContext.botId,
      team_id: workspaceContext.teamId,
      is_enterprise_install: false,
    });
    const handler = await start(appToken);
    await runSlackHandlerWithDispatch(handler, message("1700000300.000001", "A_OTHER"));
    expect(state.sendMock).not.toHaveBeenCalled();
    await runSlackHandlerWithDispatch(handler, message("1700000300.000002", "A0TOKEN"));
    await vi.waitFor(() => expect(state.sendMock).toHaveBeenCalledTimes(1));
  });

  it("does not adopt Enterprise identity from Bolt event context", async () => {
    client.auth.test.mockRejectedValue(new Error("request_timeout"));
    const handler = await start();
    await handler({
      ...message("100.000", "A_ENTERPRISE"),
      context: { ...workspaceContext, isEnterpriseInstall: true, enterpriseId: "E_ENTERPRISE" },
    });
    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
    expect(state.replyMock).not.toHaveBeenCalled();
    expect(state.sendMock).not.toHaveBeenCalled();
  });

  it("learns a stable HTTP app identity during recovery and persists Agent View under that scope", async () => {
    const register = vi.fn(async () => undefined);
    const lookup = vi.fn(async () => undefined);
    const runtime = getSlackRuntime();
    setSlackRuntime({
      ...runtime,
      state: { ...runtime.state, openKeyedStore: vi.fn(() => ({ register, lookup })) },
    } as never);
    client.auth.test.mockRejectedValue(new Error("request_timeout"));
    const handler = await start();
    expectBlockedStatus(setStatus, "request_timeout");
    expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: false }));
    await handler(message("999999.123", "A_RECOVERED"));
    expectReadyStatus(setStatus);
    expect(getSlackHandlers().has("reaction_added")).toBe(true);
    expect(getSlackInstallationTeamId("default")).toBe(workspaceContext.teamId);
    await vi.waitFor(() => expect(state.sendMock).toHaveBeenCalledTimes(1));
    await runSlackHandlerWithDispatch(handler, message("999999.124", "A_OTHER"));
    expect(state.sendMock).toHaveBeenCalledTimes(1);
    await runSlackHandlerWithDispatch(handler, {
      ...message("999999.125", "A_RECOVERED"),
      body: { api_app_id: "A_RECOVERED", team_id: "T_OTHER" },
    });
    expect(state.sendMock).toHaveBeenCalledTimes(1);
    const agentHandler = await getSlackHandlerOrThrow("app_context_changed");
    await agentHandler({
      event: { type: "app_context_changed", user: "U_OTHER", context: { entities: [] } },
      context: workspaceContext,
      body: { api_app_id: "A_RECOVERED", team_id: workspaceContext.teamId },
    });
    expect(register).toHaveBeenCalledWith(
      JSON.stringify(["workspace", "default", workspaceContext.teamId, "A_RECOVERED"]),
      { experience: "agent", observedAt: expect.any(Number) },
    );
  });
});

function userEvent(user: string, ts: string, channel: string, channel_type: "im" | "channel") {
  return { event: { type: "message", user, ts, text: "hello", channel, channel_type } };
}

function slackConfig(slack: SlackAccountConfig): OpenClawConfig {
  return { channels: { slack: { enabled: true, ...slack } } };
}

function approvalConfig(slack: SlackAccountConfig): OpenClawConfig {
  return slackConfig({ botToken: "xoxb-test", appToken: "xapp-test", ...slack });
}

async function withMonitor(
  run: (handler: Awaited<ReturnType<typeof getSlackHandlerOrThrow>>) => Promise<void>,
  options?: Parameters<typeof startSlackMonitor>[1],
) {
  const monitor = startSlackMonitor(monitorSlackProvider, options);
  try {
    await run(await getSlackHandlerOrThrow("message"));
  } finally {
    await stopSlackMonitor(monitor);
  }
}

function createRuntimeContextCapture() {
  const register = vi.fn<ChannelRuntimeSurface["runtimeContexts"]["register"]>(() => ({
    dispose: vi.fn(),
  }));
  return {
    channelRuntime: {
      inbound: { buildContext: buildChannelInboundEventContext },
      runtimeContexts: {
        register,
        get: vi.fn(),
        watch: vi.fn(() => () => {}),
      },
    } as unknown as ChannelRuntimeSurface,
    register,
  };
}

describe("slack startup user allowlist resolution", () => {
  afterEach(clearRuntimeConfigSnapshot);
  it.each(["allowBots", "room users"] as const)(
    "delivers an allowed bot's reply by default and stops subsequent turns after %s revocation",
    async (revokedPolicy) => {
      const initial: OpenClawConfig = slackConfig({
        groupPolicy: "open",
        historyLimit: 0,
        streaming: { mode: "off" },
        channels: { C123: { requireMention: true, users: ["B123BOT"] } },
      });
      await resetSlackTestState(initial);
      setRuntimeConfigSnapshot(initial, initial);
      getSlackClient().conversations.info.mockResolvedValue({
        channel: { name: "releases", is_channel: true },
      });
      replyMock.mockResolvedValue({ text: "Release is ready." });
      await withMonitor(async (handler) => {
        // Core dedupe survives monitor replacement; each case uses distinct Slack messages.
        const timestampPrefix = revokedPolicy === "allowBots" ? "202" : "203";
        const receive = (botId: string, sequence: string) =>
          runSlackHandlerWithDispatch(handler, {
            event: {
              type: "message",
              subtype: "bot_message",
              bot_id: botId,
              text: "<@bot-user> release status",
              ts: `${timestampPrefix}.${sequence}`,
              channel: "C123",
              channel_type: "channel",
            },
          });

        await receive("B123BOT", "001");
        expect(replyMock).toHaveBeenCalledTimes(1);
        expect(replyMock.mock.calls[0]?.[0]).toMatchObject({ SenderIsBot: true });
        expect(sendMock).toHaveBeenCalledExactlyOnceWith(
          "channel:C123",
          "Release is ready.",
          expect.objectContaining({ accountId: "default" }),
        );

        replyMock.mockClear();
        sendMock.mockClear();
        await receive("BDENIED", "002");
        expect([replyMock.mock.calls, sendMock.mock.calls]).toEqual([[], []]);

        const revoked: OpenClawConfig = slackConfig({
          ...initial.channels?.slack,
          ...(revokedPolicy === "allowBots"
            ? { allowBots: false }
            : { channels: { C123: { requireMention: true, users: ["UOTHER"] } } }),
        });
        setRuntimeConfigSnapshot(revoked, revoked);
        await receive("B123BOT", "003");
        expect([replyMock.mock.calls, sendMock.mock.calls]).toEqual([[], []]);
        expect(appStopMock).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects a sender revoked while workspace policy resolution is pending", async () => {
    const initial: OpenClawConfig = slackConfig({
      dangerouslyAllowNameMatching: true,
      dmPolicy: "allowlist",
      allowFrom: ["UOLD"],
    });
    await resetSlackTestState(initial);
    setRuntimeConfigSnapshot(initial, initial);
    replyMock.mockResolvedValue({ text: "ok" });
    const lookup = createDeferred<Array<{ input: string; resolved: boolean }>>();
    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await flush();
      const send = async (user: string, ts: string) => handler(userEvent(user, ts, "D123", "im"));
      await send("UOLD", "201.001");
      expect(replyMock).toHaveBeenCalledTimes(1);
      const resolving = slackConfig({ ...initial.channels?.slack, allowFrom: ["UOLD", "@lookup"] });
      resolveSlackUserAllowlistMock.mockImplementationOnce(() => lookup.promise);
      setRuntimeConfigSnapshot(resolving, resolving);
      const pending = send("UOLD", "201.002");
      await vi.waitFor(() =>
        expect(resolveSlackUserAllowlistMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ entries: ["UOLD", "@lookup"] }),
        ),
      );
      expect(replyMock).toHaveBeenCalledTimes(1);
      const revoked = slackConfig({ ...initial.channels?.slack, allowFrom: ["UNEW"] });
      setRuntimeConfigSnapshot(revoked, revoked);
      lookup.resolve([]);
      await pending;
      expect(replyMock).toHaveBeenCalledTimes(1);
      await send("UNEW", "201.003");
      expect(replyMock).toHaveBeenCalledTimes(2);
      expect(appStopMock).not.toHaveBeenCalled();
    } finally {
      lookup.resolve([]);
      await stopSlackMonitor(monitor);
    }
  });

  it("registers one native approval client per Enterprise Grid team", async () => {
    await resetSlackTestState(
      approvalConfig({
        appToken: "xapp-1-A123-test",
        dmPolicy: "disabled",
        groupPolicy: "open",
        execApprovals: { enabled: true, approvers: ["U123OWNER"], target: "both" },
      }),
    );
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UENTERPRISE",
      bot_id: "BENTERPRISE",
      enterprise_id: "E123",
      app_id: "A123",
      is_enterprise_install: true,
    });
    const { channelRuntime, register } = createRuntimeContextCapture();

    await withMonitor(
      async () => {
        await flush();

        const registration = vi.mocked(register).mock.calls[0]?.[0] as
          | { context?: { resolveClient?: (teamId?: string) => unknown } }
          | undefined;
        const resolveClient = registration?.context?.resolveClient;
        expect(resolveClient).toBeTypeOf("function");
        const teamOne = resolveClient?.("T111") as { teamId?: string };
        expect(resolveClient?.("T111")).toBe(teamOne);
        const teamTwo = resolveClient?.("T222") as { teamId?: string };

        expect(teamTwo).not.toBe(teamOne);
        expect([teamOne.teamId, teamTwo.teamId]).toEqual(["T111", "T222"]);
      },
      { channelRuntime, appToken: "xapp-1-A123-test" },
    );
  });

  it("registers the native approval runtime for plugin-only Slack approvals", async () => {
    await resetSlackTestState({
      ...approvalConfig({
        allowFrom: ["U123OWNER"],
        execApprovals: { enabled: false, approvers: ["U999EXEC"], target: "both" },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123OWNER" }],
        },
      },
    });
    const { channelRuntime, register } = createRuntimeContextCapture();

    await withMonitor(
      async () => {
        await flush();

        expect(register).toHaveBeenCalledWith(
          expect.objectContaining({
            channelId: "slack",
            accountId: "default",
            capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
            context: expect.objectContaining({
              config: expect.objectContaining({ enabled: false }),
              workspaceTeamId: "T_TEST",
            }),
          }),
        );
      },
      { channelRuntime },
    );
  });

  it("skips user entry resolution when name matching is not enabled", async () => {
    await resetSlackTestState({
      messages: { responsePrefix: "PFX" },
      ...slackConfig({
        dmPolicy: "allowlist",
        allowFrom: ["<@U123GLOBAL>", "@global-user"],
        channels: {
          C123: {
            enabled: true,
            requireMention: false,
            users: ["<@U123CHANNEL>", "@channel-user"],
          },
        },
      }),
    });
    replyMock.mockResolvedValue({ text: "ok" });

    await withMonitor(async (handler) => {
      await flush();
      await flush();

      expect(resolveSlackUserAllowlistMock).not.toHaveBeenCalled();

      await handler(userEvent("U123GLOBAL", "100.000", "D123", "im"));
      expect(replyMock).toHaveBeenCalledTimes(1);

      replyMock.mockClear();
      await handler(userEvent("U123CHANNEL", "101.000", "C123", "channel"));
      expect(replyMock).toHaveBeenCalledTimes(1);
    });
  });
});
