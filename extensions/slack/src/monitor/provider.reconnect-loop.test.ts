import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { getSlackClient, getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");
const slackTestState = getSlackTestState();

describe("slack socket reconnect loop", () => {
  let controller: AbortController;
  let runtime: ReturnType<typeof createRuntimeSpies>;
  const setStatus = vi.fn<(next: Record<string, unknown>) => void>();
  const start = () =>
    monitorSlackProvider({
      scheduler: createTestPluginServiceScheduler(),
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime,
      setStatus,
    });
  beforeEach(async () => {
    await resetSlackTestState();
    controller = new AbortController();
    runtime = createRuntimeSpies();
    setStatus.mockClear();
    // Reconnect backoff uses timeouts. Keep ingress polling and SQLite WAL intervals
    // real so runAllTimersAsync cannot turn periodic maintenance into an infinite loop.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("continues after thirteen consecutive recoverable Slack Web API HTTP failures", async () => {
    let attempts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts <= 13) {
        throw Object.assign(new Error("Slack Web API HTTP error"), {
          code: "slack_webapi_http_error",
          statusCode: 503,
          statusMessage: "Service Unavailable",
        });
      }
      controller.abort();
    });

    const run = start();

    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();

    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(14);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("retry 13/∞"));
    const error =
      "Slack Web API HTTP error; code: slack_webapi_http_error; statusCode: 503; statusMessage: Service Unavailable";
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "recovering",
      lastDisconnect: { at: expect.any(Number), error },
      lastError: error,
    });
  });

  it("includes the configured Socket Mode logger context in start retry diagnostics", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        slackTestState.socketModeLogger?.error("failed to retrieve WSS URL", {
          data: { error: "missing_scope", needed: "connections:write" },
        });
        throw new Error();
      }
      controller.abort();
    });

    const run = start();

    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "last SDK log: socket-mode:socket-mode failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      ),
    );
  });

  it("publishes blocked before rejecting a non-recoverable socket start failure", async () => {
    slackTestState.appStartMock.mockRejectedValue(new Error("invalid_auth"));

    await expect(start()).rejects.toThrow("invalid_auth");

    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "invalid_auth",
    });
  });

  it("re-resolves degraded identity after a recoverable reconnect", async () => {
    getSlackClient().auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UUSER",
      team_id: "T1",
      is_enterprise_install: false,
    });
    let attempts = 0;
    let resolveSecondStart: (() => void) | undefined;
    const secondStart = new Promise<void>((resolve) => {
      resolveSecondStart = resolve;
    });
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ECONNRESET");
      }
      resolveSecondStart?.();
    });

    const run = start();

    await vi.runOnlyPendingTimersAsync();
    await secondStart;
    await Promise.resolve();
    await Promise.resolve();

    expect(setStatus).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: undefined,
      lifecycle: "ready",
      lastError: null,
    });
    expect(setStatus.mock.calls.find(([patch]) => patch.connected)?.[0]).not.toHaveProperty(
      "lastEventAt",
    );
    expect(getSlackClient().auth.test).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  it("retries a transient identity failure while the socket stays connected", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    getSlackClient()
      .auth.test.mockRejectedValueOnce(new Error("request_timeout"))
      .mockRejectedValueOnce(new Error("request_timeout"))
      .mockResolvedValueOnce({
        user_id: "UBOT",
        bot_id: "BBOT",
        team_id: "T1",
        is_enterprise_install: false,
      });
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    slackTestState.appStartMock.mockImplementation(async () => {
      resolveStarted?.();
    });

    const run = start();

    await started;
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: true,
      lifecycle: "blocked",
      lastError: "request_timeout",
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getSlackClient().auth.test).toHaveBeenCalledTimes(3);
    expect(setStatus).toHaveBeenLastCalledWith({
      running: true,
      connected: true,
      lastConnectedAt: expect.any(Number),
      terminalDisconnect: undefined,
      lifecycle: "ready",
      lastError: null,
    });
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  async function holdScheduledIdentityRecoveryAcrossDisconnect() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let settleAuth:
      | { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }
      | undefined;
    getSlackClient()
      .auth.test.mockRejectedValueOnce(new Error("request_timeout"))
      .mockRejectedValueOnce(new Error("request_timeout"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settleAuth = { resolve, reject };
          }),
      );
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    slackTestState.appStartMock
      .mockImplementationOnce(async () => {
        resolveStarted?.();
      })
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      );

    const run = start();
    await started;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getSlackClient().auth.test).toHaveBeenCalledTimes(3);

    const receiver = slackTestState.appConstructorArgs?.receiver as {
      client: { emit: (event: string) => boolean };
    };
    receiver.client.emit("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    const disconnectedStatus = {
      connected: false,
      lifecycle: "recovering",
      lastDisconnect: { at: expect.any(Number) },
      lastError: null,
    };
    expect(setStatus).toHaveBeenLastCalledWith(disconnectedStatus);
    return { run, settleAuth: settleAuth!, disconnectedStatus };
  }

  it("keeps a disconnected socket disconnected when in-flight identity recovery succeeds", async () => {
    const { run, settleAuth, disconnectedStatus } =
      await holdScheduledIdentityRecoveryAcrossDisconnect();

    settleAuth.resolve({
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T1",
      is_enterprise_install: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(setStatus).toHaveBeenLastCalledWith(disconnectedStatus);
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  it("does not rearm identity recovery when an in-flight attempt fails after disconnect", async () => {
    const { run, settleAuth, disconnectedStatus } =
      await holdScheduledIdentityRecoveryAcrossDisconnect();

    settleAuth.reject(new Error("request_timeout"));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(getSlackClient().auth.test).toHaveBeenCalledTimes(3);
    expect(setStatus).toHaveBeenLastCalledWith(disconnectedStatus);
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });
});
