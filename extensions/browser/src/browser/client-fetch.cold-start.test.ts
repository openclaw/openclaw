import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import * as cdpHelpers from "./cdp.helpers.js";
import { launchOpenClawChrome, isChromeReachable, isChromeCdpReady } from "./chrome.js";
import type { RunningChrome } from "./chrome.js";
import { fetchBrowserJson } from "./client-fetch.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserServerState, mockLaunchedChrome } from "./server-context.test-harness.js";

const service = vi.hoisted(() => ({
  context: vi.fn(),
  start: vi.fn(),
  state: vi.fn(),
  readTabs: vi.fn(),
}));
// mock-isolation: keep the service in memory; real startup installs host relays and credentials.
vi.mock("../control-service.js", () => ({
  createBrowserControlContext: service.context,
  startBrowserControlServiceFromConfig: service.start,
  getBrowserControlState: service.state,
  stopBrowserControlService: vi.fn(async () => {}),
}));

function setup() {
  vi.useFakeTimers();
  const state = makeBrowserServerState();
  const context = createBrowserRouteContext({ getState: () => state });
  service.context.mockReturnValue(context);
  service.start.mockResolvedValue(state);
  service.state.mockReturnValue(state);
  service.readTabs.mockResolvedValue([]);
  vi.spyOn(cdpHelpers, "fetchJson").mockImplementation(service.readTabs);
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<RunningChrome>();
  const running = mockLaunchedChrome(vi.mocked(launchOpenClawChrome), 1200);
  vi.mocked(isChromeReachable).mockResolvedValue(false);
  vi.mocked(isChromeCdpReady).mockResolvedValue(true);
  vi.mocked(launchOpenClawChrome).mockImplementation(async () => {
    entered.resolve();
    return await ready.promise;
  });
  return { state, context, entered, ready, running };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser control cold start", () => {
  it("waits beyond the action budget for startup and reuses the browser", async () => {
    const { entered, ready, running, state } = setup();
    const first = fetchBrowserJson("/start", { method: "POST", timeoutMs: 20_000 });
    const result = first.catch((error: unknown) => error);
    await entered.promise;
    const tabs = fetchBrowserJson("/tabs", { timeoutMs: 20_000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31_000);
    ready.resolve(running);
    expect(await result).toEqual({ ok: true, profile: "openclaw" });
    expect(await tabs).toEqual({ running: true, tabs: [], canAutoResizeViewport: true });
    await expect(
      fetchBrowserJson("/start", { method: "POST", timeoutMs: 20_000 }),
    ).resolves.toEqual({ ok: true, profile: "openclaw" });
    expect(state.profiles.get("openclaw")?.running).toBe(running);
    expect(launchOpenClawChrome).toHaveBeenCalledOnce();
  });

  it("abandons an expired caller without cancelling the shared launch", async () => {
    const { entered, ready, running, state } = setup();
    const caller = new AbortController();
    const first = fetchBrowserJson("/start", {
      method: "POST",
      timeoutMs: 20_000,
      signal: caller.signal,
    });
    const cancelled = expect(first).rejects.toThrow("caller deadline expired");
    await entered.promise;
    setTimeout(() => caller.abort(new Error("caller deadline expired")), 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await cancelled;
    const next = fetchBrowserJson("/start", { method: "POST", timeoutMs: 20_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    ready.resolve(running);
    await expect(next).resolves.toEqual({ ok: true, profile: "openclaw" });
    expect(state.profiles.get("openclaw")?.running).toBe(running);
    expect(launchOpenClawChrome).toHaveBeenCalledOnce();
  });

  it("enforces the action deadline after startup completes", async () => {
    const { entered, ready, running } = setup();
    const start = fetchBrowserJson("/start", { method: "POST", timeoutMs: 20_000 });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(31_000);
    ready.resolve(running);
    await start;
    const reading = Promise.withResolvers<void>();
    const tabList = Promise.withResolvers<[]>();
    service.readTabs.mockImplementationOnce(() => {
      reading.resolve();
      return tabList.promise;
    });
    const tabs = fetchBrowserJson("/tabs", { timeoutMs: 20_000 });
    const expired = expect(tabs).rejects.toThrow("timed out");
    await reading.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    tabList.resolve([]);
    await expired;
  });

  it("bounds a stuck launch with the service startup deadline", async () => {
    const { entered, state } = setup();
    vi.mocked(launchOpenClawChrome).mockImplementationOnce(async (_resolved, _profile, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("expected lifecycle-owned launch signal");
      }
      entered.resolve();
      return await new Promise<RunningChrome>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error("Browser startup aborted"));
          },
          { once: true },
        );
      });
    });
    const start = fetchBrowserJson("/start", { method: "POST", timeoutMs: 20_000 });
    const expired = expect(start).rejects.toThrow(
      'Browser startup for profile "openclaw" did not finish within 120000ms',
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    await expired;
    expect(state.profiles.get("openclaw")?.running).toBeNull();
  });
});
