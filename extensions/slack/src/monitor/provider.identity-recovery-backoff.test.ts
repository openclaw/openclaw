// Slack tests cover background identity re-resolution after a failed startup auth.test.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebClient } from "@slack/web-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeSlackTestRuntime,
  getSlackClient,
  resetSlackTestState,
  startSlackMonitor as startSlackMonitorUntracked,
  stopSlackMonitor,
  useSlackStartupAuthClientOnce,
} from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");

type StartedSlackMonitor = ReturnType<typeof startSlackMonitorUntracked>;

const startedMonitors: StartedSlackMonitor[] = [];

function startSlackMonitor(...args: Parameters<typeof startSlackMonitorUntracked>) {
  const monitor = startSlackMonitorUntracked(...args);
  startedMonitors.push(monitor);
  return monitor;
}

const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

// Real SDK client with retries disabled, so one recovery attempt is exactly one
// request against the local mock API. The provider's own fetch wrapper survives
// the spread, which is what the teardown-cancellation case relies on.
function useRealSlackStartupAuthClientTimes(count: number, timeoutMs: number): void {
  for (let i = 0; i < count; i += 1) {
    useSlackStartupAuthClientOnce(
      (token, options) =>
        new WebClient(token, { ...options, retryConfig: { retries: 0 }, timeout: timeoutMs }),
    );
  }
}

/**
 * Mock Slack API that fails `auth.test` a fixed number of times before serving a
 * valid bot identity. Requests go through the real startup auth client, so the
 * boot failure, its retry policy, and recovery all exercise production code.
 */
async function startRecoveringSlackApiServer(params: {
  failures: number;
  failureBody?: Record<string, unknown>;
  /** Requests from this 1-based index onward never answer, simulating a hung API. */
  stallFrom?: number;
  events?: string[];
}) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    if (params.stallFrom !== undefined && requestCount >= params.stallFrom) {
      params.events?.push(`stalled-request-${requestCount}`);
      request.socket.once("close", () => {
        params.events?.push("socket-closed");
      });
      return;
    }
    const body =
      requestCount <= params.failures
        ? JSON.stringify(params.failureBody ?? { ok: false, error: "internal_error" })
        : JSON.stringify({
            ok: true,
            user_id: "U0RECOVERED",
            bot_id: "B0RECOVERED",
            team_id: "T0TEST",
            is_enterprise_install: false,
          });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    get requestCount() {
      return requestCount;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

beforeEach(async () => {
  await resetSlackTestState();
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, "");
  }
});

afterEach(async () => {
  const monitors = startedMonitors.splice(0);
  for (const monitor of monitors) {
    monitor.controller.abort();
  }
  await Promise.allSettled(monitors.map((monitor) => monitor.run));
  getSlackClient().auth.test.mockReset();
  await resetSlackTestState();
  vi.unstubAllEnvs();
});

afterAll(() => {
  disposeSlackTestRuntime();
});

describe("blocked identity recovery backoff", () => {
  it("recovers identity and publishes ready status through the real auth client", async () => {
    // Fail the boot attempt and the socket-start attempt, so only the background
    // loop can recover: this is the state a stable Socket Mode connection reaches.
    const server = await startRecoveringSlackApiServer({ failures: 2 });
    vi.stubEnv("SLACK_API_URL", server.apiUrl);
    useRealSlackStartupAuthClientTimes(3, 2_000);

    const runtimeLog = vi.fn();
    const statusPatches: Record<string, unknown>[] = [];
    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
      setStatus: (next) => {
        statusPatches.push(next);
      },
    });
    try {
      await vi.waitFor(
        () =>
          expect(runtimeLog).toHaveBeenCalledWith(
            expect.stringContaining("slack auth.test failed at boot"),
          ),
        { timeout: 10_000, interval: 250 },
      );
      await vi.waitFor(
        () =>
          expect(runtimeLog).toHaveBeenCalledWith(
            expect.stringContaining("slack identity recovered"),
          ),
        { timeout: 30_000, interval: 250 },
      );
      // Status must flip to ready, otherwise the gateway keeps reporting the
      // blocked patch for a transport whose mention detection already works.
      await vi.waitFor(
        () => expect(statusPatches.some((patch) => patch.lifecycle === "ready")).toBe(true),
        { timeout: 5_000, interval: 100 },
      );
      // Pins recovery to the real client path rather than a fallback mock.
      expect(server.requestCount).toBe(3);
    } finally {
      await stopSlackMonitor(monitor);
      await server.close();
    }
  }, 45_000);

  it("stops recovery attempts when the identity failure is non-recoverable", async () => {
    // invalid_auth is operator-action-required; retrying it forever would issue
    // auth requests for the life of the process.
    const server = await startRecoveringSlackApiServer({
      failures: Number.MAX_SAFE_INTEGER,
      failureBody: { ok: false, error: "invalid_auth" },
    });
    vi.stubEnv("SLACK_API_URL", server.apiUrl);
    useRealSlackStartupAuthClientTimes(4, 2_000);

    const runtimeError = vi.fn();
    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
    });
    try {
      await vi.waitFor(
        () =>
          expect(runtimeError).toHaveBeenCalledWith(
            expect.stringContaining("slack identity recovery stopped"),
          ),
        { timeout: 30_000, interval: 250 },
      );
      const requestsAtStop = server.requestCount;
      // The loop's next backoff step would be ~20s; no further attempts may land.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000);
      });
      expect(server.requestCount).toBe(requestsAtStop);
    } finally {
      await stopSlackMonitor(monitor);
      await server.close();
    }
  }, 45_000);

  it("cancels an in-flight recovery auth request when the provider stops", async () => {
    const events: string[] = [];
    // Boot and socket-start attempts fail fast; the loop's attempt hangs, so the
    // only thing that can end it is provider teardown.
    const server = await startRecoveringSlackApiServer({ failures: 2, stallFrom: 3, events });
    vi.stubEnv("SLACK_API_URL", server.apiUrl);
    // The stalled attempt must outlive its own client timeout, so the lifecycle
    // abort is the only thing that can close it.
    useRealSlackStartupAuthClientTimes(3, 60_000);

    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    try {
      await vi.waitFor(() => expect(events).toContain("stalled-request-3"), {
        timeout: 30_000,
        interval: 250,
      });
      await stopSlackMonitor(monitor);
      // Without a lifecycle-bound fetch signal the request would keep running on
      // its own timeout after teardown.
      await vi.waitFor(() => expect(events).toContain("socket-closed"), {
        timeout: 5_000,
        interval: 100,
      });
    } finally {
      await server.close();
    }
  }, 45_000);
});
