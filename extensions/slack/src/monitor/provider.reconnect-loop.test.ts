import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  function failStarts(count: number, error: () => Error, ready = () => controller.abort()) {
    let attempts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      if (attempts++ < count) {
        throw error();
      }
      ready();
    });
  }
  async function finishRetries() {
    const run = start();
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();
  }
  beforeEach(async () => {
    await resetSlackTestState();
    controller = new AbortController();
    runtime = createRuntimeSpies();
    setStatus.mockClear();
    // Keep ingress/WAL intervals real; runAllTimersAsync must only drain reconnect timeouts.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("continues after thirteen consecutive recoverable Slack Web API HTTP failures", async () => {
    failStarts(13, () =>
      Object.assign(new Error("Slack Web API HTTP error"), {
        code: "slack_webapi_http_error",
        statusCode: 503,
        statusMessage: "Service Unavailable",
      }),
    );
    await finishRetries();
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
    failStarts(1, () => {
      slackTestState.socketModeLogger?.error("failed to retrieve WSS URL", {
        data: { error: "missing_scope", needed: "connections:write" },
      });
      return new Error();
    });
    await finishRetries();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "last SDK log: socket-mode:socket-mode failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      ),
    );
  });
  it.each(["token_revoked", "invalid_auth"])("blocks %s", async (error) => {
    slackTestState.appStartMock.mockRejectedValue(new Error(error));
    const rejected = expect(start()).rejects.toThrow(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(error === "token_revoked" ? 1 : 3);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: error,
    });
  });
  it("re-resolves degraded identity after a recoverable reconnect", async () => {
    getSlackClient().auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UUSER",
      team_id: "T1",
      is_enterprise_install: false,
    });
    const secondStart = createDeferred<void>();
    failStarts(1, () => new Error("ECONNRESET"), secondStart.resolve);
    const run = start();
    await vi.runOnlyPendingTimersAsync();
    await secondStart.promise;
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
  it("recovers a single invalid_auth start failure without blocking the channel", async () => {
    failStarts(1, () => new Error("invalid_auth"));
    await finishRetries();
    expect(setStatus.mock.calls.some(([next]) => next.lifecycle === "blocked")).toBe(false);
  });
  it("resets auth failures and disconnect episodes after a successful reconnect", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 60_000));
    let attempts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts !== 2) {
        throw new Error("invalid_auth");
      }
      // Connected once, then the SDK reports an auth failure on the live socket.
      slackTestState.socketModeClient?.emit(
        "unable_to_socket_mode_start",
        new Error("invalid_auth"),
      );
    });
    const run = start();
    await vi.runAllTimersAsync();
    await expect(run).rejects.toThrow("invalid_auth");
    // One failure before connection, then three consecutive failures.
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(4);
    const [first, ...retries] = setStatus.mock.calls
      .filter(([patch]) => patch.lifecycle === "recovering")
      .map(([patch]) => patch.lastDisconnect);
    expect(retries[0]).not.toEqual(first);
    expect(retries).toEqual([retries[0], retries[0]]);
  });
});
