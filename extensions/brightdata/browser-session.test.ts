import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function resetBrowserSessions(): Promise<void> {
  const { __testing } = await import("./src/brightdata-browser-tools.js");
  await __testing.resetBrowserSessions();
}

describe("brightdata browser session management", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await resetBrowserSessions();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetBrowserSessions();
  });

  it("isolates browser sessions by OpenClaw session context", async () => {
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    const closedEndpoints: string[] = [];

    const createSession = (cdpEndpoint: string) =>
      ({
        close: vi.fn(async () => {
          closedEndpoints.push(cdpEndpoint);
        }),
      }) as never;

    const resolveCdpEndpoint = async (params: { country?: string }) =>
      `wss://example.invalid/${params.country ?? "default"}`;

    const first = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      createSession,
      resolveCdpEndpoint,
    });
    const second = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      createSession,
      resolveCdpEndpoint,
    });
    const other = await __testing.requireBrowserSession({
      context: { sessionId: "session-b" },
      createSession,
      resolveCdpEndpoint,
    });

    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(closedEndpoints).toEqual([]);
  });

  it("recreates a session when the country changes within the same OpenClaw session", async () => {
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    const closedEndpoints: string[] = [];

    const createSession = (cdpEndpoint: string) =>
      ({
        close: vi.fn(async () => {
          closedEndpoints.push(cdpEndpoint);
        }),
      }) as never;

    const resolveCdpEndpoint = async (params: { country?: string }) =>
      `wss://example.invalid/${params.country ?? "default"}`;

    const first = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      country: "US",
      createSession,
      resolveCdpEndpoint,
    });
    const second = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      country: "GB",
      createSession,
      resolveCdpEndpoint,
    });

    expect(second).not.toBe(first);
    expect(closedEndpoints).toEqual(["wss://example.invalid/us"]);
  });

  it("evicts idle scoped browser sessions after the idle TTL", async () => {
    vi.useFakeTimers();
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    const closedEndpoints: string[] = [];

    const createSession = (cdpEndpoint: string) =>
      ({
        close: vi.fn(async () => {
          closedEndpoints.push(cdpEndpoint);
        }),
      }) as never;

    const resolveCdpEndpoint = async (params: { country?: string }) =>
      `wss://example.invalid/${params.country ?? "default"}`;

    const first = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      createSession,
      resolveCdpEndpoint,
    });

    expect(__testing.getBrowserSessionCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(
      __testing.BROWSER_SESSION_IDLE_TTL_MS + __testing.BROWSER_SESSION_SWEEP_INTERVAL_MS,
    );

    expect(__testing.getBrowserSessionCount()).toBe(0);
    expect(closedEndpoints).toEqual(["wss://example.invalid/default"]);

    const second = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      createSession,
      resolveCdpEndpoint,
    });

    expect(second).not.toBe(first);
  });

  it("refreshes the idle timer when a scoped browser session is reused", async () => {
    vi.useFakeTimers();
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    const closedEndpoints: string[] = [];

    const createSession = (cdpEndpoint: string) =>
      ({
        close: vi.fn(async () => {
          closedEndpoints.push(cdpEndpoint);
        }),
      }) as never;

    const resolveCdpEndpoint = async (params: { country?: string }) =>
      `wss://example.invalid/${params.country ?? "default"}`;

    const first = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      createSession,
      resolveCdpEndpoint,
    });

    const halfIdleTtlMs = Math.floor(__testing.BROWSER_SESSION_IDLE_TTL_MS / 2);

    await vi.advanceTimersByTimeAsync(halfIdleTtlMs);

    const second = await __testing.requireBrowserSession({
      context: { sessionId: "session-a" },
      createSession,
      resolveCdpEndpoint,
    });

    expect(second).toBe(first);

    await vi.advanceTimersByTimeAsync(halfIdleTtlMs + __testing.BROWSER_SESSION_SWEEP_INTERVAL_MS);

    expect(__testing.getBrowserSessionCount()).toBe(1);
    expect(closedEndpoints).toEqual([]);

    await vi.advanceTimersByTimeAsync(halfIdleTtlMs + __testing.BROWSER_SESSION_SWEEP_INTERVAL_MS);

    expect(__testing.getBrowserSessionCount()).toBe(0);
    expect(closedEndpoints).toEqual(["wss://example.invalid/default"]);
  });

  it("retries page metadata reads when navigation briefly destroys the execution context", async () => {
    const { __testing } = await import("./src/brightdata-browser-tools.js");
    const page = {
      title: vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(
          new Error(
            "page.title: Execution context was destroyed, most likely because of a navigation",
          ),
        )
        .mockResolvedValueOnce("Example Domain"),
      url: vi.fn(() => "https://example.com"),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
    };

    await expect(__testing.readPageMetadata(page as never)).resolves.toEqual({
      title: "Example Domain",
      url: "https://example.com",
    });
    expect(page.title).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(1);
  });
});
