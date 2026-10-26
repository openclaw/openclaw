import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfig,
  createRuntime,
  updateMSTeamsConfig,
} from "./monitor-lifecycle.test-helpers.js";
import {
  loadMSTeamsSdkWithAuth,
  resetMSTeamsMonitorMocks,
  routeState,
} from "./monitor-lifecycle.test-support.js";
import { monitorMSTeamsProvider } from "./monitor.js";

describe("Microsoft Teams monitor status", () => {
  afterEach(resetMSTeamsMonitorMocks);

  it("publishes ready after registration and stopped after shutdown", async () => {
    const abort = new AbortController();
    const statusSink = vi.fn();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      statusSink,
    });
    try {
      await routeState.ready.promise;
      expect(statusSink.mock.calls.map(([patch]) => patch)).toEqual([
        {
          lifecycle: "ready",
          running: true,
          connected: true,
          lastConnectedAt: expect.any(Number),
          lastError: null,
          terminalDisconnect: undefined,
        },
      ]);
    } finally {
      abort.abort();
      await task;
    }
    expect(statusSink.mock.calls.map(([patch]) => patch.lifecycle)).toEqual(["ready", "stopped"]);
    expect(statusSink).toHaveBeenLastCalledWith({
      lifecycle: "stopped",
      running: false,
      connected: false,
    });
  });

  it.each([
    { enabled: false, appId: "app-id", error: "Microsoft Teams provider is disabled" },
    { enabled: true, appId: "", error: "Microsoft Teams credentials are not configured" },
  ])("reports blocked before SDK startup: $error", async ({ enabled, appId, error }) => {
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      accounts: { support: { enabled, appId, appPassword: "" } },
    });
    const statusSink = vi.fn();
    await monitorMSTeamsProvider({
      cfg,
      accountId: "support",
      runtime: createRuntime(),
      statusSink,
    });
    expect(statusSink).toHaveBeenCalledExactlyOnceWith({
      lifecycle: "blocked",
      running: true,
      terminalDisconnect: true,
      lastError: error,
    });
    expect(loadMSTeamsSdkWithAuth).not.toHaveBeenCalled();
    expect(routeState.routes).toEqual([]);
  });
});
