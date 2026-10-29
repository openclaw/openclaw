import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import { PROFILE_ATTACH_RETRY_TIMEOUT_MS } from "./cdp-timeouts.js";
import type { RunningChrome } from "./chrome.js";
import * as chromeModule from "./chrome.js";
import { BROWSER_ERROR_REASONS, BrowserProfileUnavailableError } from "./errors.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition, getProfileLifecycle } from "./server-context.lifecycle.js";
import {
  makeBrowserProfile,
  makeBrowserServerState,
  mockLaunchedChrome,
} from "./server-context.test-harness.js";
import type { ProfileRuntimeState } from "./server-context.types.js";

const chrome = {
  launch: vi.mocked(chromeModule.launchOpenClawChrome),
  stop: vi.mocked(chromeModule.stopOpenClawChrome),
  reachable: vi.mocked(chromeModule.isChromeReachable),
  ownsCdp: vi.mocked(chromeModule.isChromeCdpOwnedByPid),
  ready: vi.mocked(chromeModule.isChromeCdpReady),
  inspectMode: vi.mocked(chromeModule.inspectLocalChromeHeadlessMode),
};

function fakeRunning(pid: number): RunningChrome {
  return mockLaunchedChrome(vi.fn(), pid);
}

function deferResult<T>(mock: { mockImplementationOnce: (fn: () => Promise<T>) => unknown }) {
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<T>();
  mock.mockImplementationOnce(async () => {
    entered.resolve();
    return await result.promise;
  });
  return { entered, result };
}

function setupEnsureBrowserAvailableHarness(params?: Parameters<typeof makeBrowserServerState>[0]) {
  const state = makeBrowserServerState(params);
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profile = ctx.forProfile();
  const runtime = state.profiles.get(state.resolved.defaultProfile);
  if (!runtime) {
    throw new Error("expected profile runtime");
  }
  const freshProfile = () => createBrowserRouteContext({ getState: () => state }).forProfile();
  return { profile, state, runtime, freshProfile };
}

function createAttachOnlyLoopbackProfile(cdpUrl: string) {
  return setupEnsureBrowserAvailableHarness({
    profile: makeBrowserProfile({ name: "manual-cdp", cdpUrl, cdpPort: 9222, attachOnly: true }),
    resolvedOverrides: { ssrfPolicy: {} },
  });
}

function expectNoProcessChanges() {
  expect(chrome.launch).not.toHaveBeenCalled();
  expect(chrome.stop).not.toHaveBeenCalled();
}

function diagnosticReady(cdpUrl: string, instance: string) {
  return async (...args: Parameters<typeof chromeModule.isChromeCdpReady>) => {
    await args[4]?.onDiagnostic?.({
      ok: true,
      cdpUrl,
      wsUrl: `${cdpUrl.replace("http", "ws")}/devtools/browser/${instance}`,
      elapsedMs: 1,
    });
    return true;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser server-context ensureBrowserAvailable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chrome.reachable.mockResolvedValue(false);
    chrome.ownsCdp.mockResolvedValue(true);
    chrome.ready.mockResolvedValue(true);
  });

  it("keeps a shared launch running when one caller cancels its wait", async () => {
    const { profile, runtime, freshProfile } = setupEnsureBrowserAvailableHarness();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const { entered, result: launch } = deferResult(chrome.launch);
    const running = fakeRunning(1200);

    const first = profile.ensureBrowserAvailable({ signal: controller.signal });
    const second = freshProfile().ensureBrowserAvailable();
    await entered.promise;
    const cancelled = expect(first).rejects.toBe(reason);
    controller.abort(reason);
    await cancelled;
    launch.resolve(running);
    await expect(second).resolves.toBeUndefined();

    expect(runtime.running).toBe(running);
    expect(chrome.launch).toHaveBeenCalledOnce();
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it.each(["stop", "config change"])(
    "cleans a deferred launch on %s without counting a failure and allows restart",
    async (reason) => {
      const { profile, state, runtime } = setupEnsureBrowserAvailableHarness();
      const previousFailure =
        reason === "stop"
          ? undefined
          : { consecutiveFailures: 2, lastError: "earlier launch failure" };
      runtime.managedLaunchFailure = previousFailure;
      const { entered: launchEntered, result: deferredLaunch } = deferResult(chrome.launch);
      const late = fakeRunning(1201);
      const replacement = fakeRunning(1202);
      chrome.launch.mockResolvedValueOnce(replacement);

      const start = profile.ensureBrowserAvailable();
      await launchEntered.promise;
      expect(chrome.launch).toHaveBeenCalledTimes(1);
      const canceling =
        reason === "stop"
          ? profile.stopRunningBrowser()
          : beginProfileTransition({ state, runtime, reason: "profile config changed" });
      deferredLaunch.resolve(late);

      await expect(start).rejects.toThrow(/lifecycle changed|superseded/i);
      await expect(canceling).resolves.toEqual({ stopped: true });
      expect(runtime.managedLaunchFailure).toBe(previousFailure);
      expect(chrome.stop).toHaveBeenCalledExactlyOnceWith(late);
      expect(runtime.running).toBeNull();
      expect(getProfileLifecycle(runtime).handles.size).toBe(0);
      await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
      expect(chrome.launch).toHaveBeenCalledTimes(2);
      expect(chrome.stop).toHaveBeenCalledTimes(1);
      expect(runtime.running).toBe(replacement);
      expect(runtime.managedLaunchFailure).toBeUndefined();
    },
  );

  it("keeps Chrome across startup and later operations when readiness responses take 750ms", async () => {
    const { profile, runtime } = setupEnsureBrowserAvailableHarness();
    chrome.ready.mockImplementation(
      async (_url, timeoutMs = 0) =>
        await new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(timeoutMs >= 750), Math.min(750, timeoutMs));
        }),
    );
    const launched = mockLaunchedChrome(chrome.launch, 124);

    const ready = expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(8100);
    await ready;

    chrome.reachable.mockImplementation(async () => Boolean(runtime.running));
    const reused = expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(8100);
    await reused;

    expect(chrome.launch).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBe(launched);
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("stops launched chrome when CDP readiness never arrives", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    state.resolved.localCdpReadyTimeoutMs = 250;
    chrome.ready.mockResolvedValue(false);
    mockLaunchedChrome(chrome.launch, 321);

    const promise = profile.ensureBrowserAvailable();
    const rejected = expect(promise).rejects.toThrow("not reachable after start");
    const diagnosticRejected = expect(promise).rejects.toThrow(
      "CDP diagnostic: websocket_health_command_timeout; mock CDP diagnostic.",
    );
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    await diagnosticRejected;

    expect(chrome.launch).toHaveBeenCalledTimes(1);
    expect(chrome.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign listener that wins the managed CDP port after spawn", async () => {
    const { profile, runtime } = setupEnsureBrowserAvailableHarness();
    const launched = fakeRunning(1234);
    chrome.launch.mockResolvedValue(launched);
    chrome.ownsCdp.mockResolvedValue(false);

    await expect(profile.ensureBrowserAvailable()).rejects.toThrow("did not own its CDP endpoint");

    expect(chrome.ownsCdp).toHaveBeenCalledWith(
      "http://127.0.0.1:18800",
      launched.pid,
      expect.any(Number),
      undefined,
      expect.any(AbortSignal),
    );
    expect(chrome.stop).toHaveBeenCalledExactlyOnceWith(launched);
    expect(runtime.running).toBeNull();
  });

  it("does not adopt a managed child that exits during the ownership probe", async () => {
    const { profile, runtime } = setupEnsureBrowserAvailableHarness();
    const launched = fakeRunning(1235);
    const { entered: ownershipEntered, result: ownership } = deferResult(chrome.ownsCdp);
    chrome.launch.mockResolvedValue(launched);

    const start = profile.ensureBrowserAvailable();
    await ownershipEntered.promise;
    launched.proc.emit("exit", 0, null);
    ownership.resolve(true);

    await expect(start).rejects.toThrow("exited before adoption");
    expect(runtime.running).toBeNull();
    expect(getProfileLifecycle(runtime).handles.size).toBe(0);
    expect(chrome.stop).toHaveBeenCalledExactlyOnceWith(launched);
  });

  it("passes request-local headless override to the owned restart path", async () => {
    const { profile, runtime } = setupEnsureBrowserAvailableHarness();
    runtime.running = fakeRunning(111);
    chrome.reachable.mockImplementation(async () => Boolean(runtime.running));
    chrome.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockLaunchedChrome(chrome.launch, 987);

    await expect(profile.ensureBrowserAvailable({ headless: true })).resolves.toBeUndefined();

    expect(chrome.stop).toHaveBeenCalledTimes(1);
    expect(chrome.launch).toHaveBeenCalledTimes(1);
    expect(chrome.launch.mock.calls[0]?.[2]).toMatchObject({
      headlessOverride: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("clears the concurrent lazy-start guard after launch failure", async () => {
    const { profile } = setupEnsureBrowserAvailableHarness();
    chrome.launch.mockRejectedValueOnce(
      new Error("PortInUseError: listen EADDRINUSE 127.0.0.1:18800"),
    );

    const first = profile.ensureBrowserAvailable();
    const second = profile.ensureBrowserAvailable();
    await expect(Promise.all([first, second])).rejects.toThrow("PortInUseError");

    mockLaunchedChrome(chrome.launch, 789);
    const retry = profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(100);
    await expect(retry).resolves.toBeUndefined();

    expect(chrome.launch).toHaveBeenCalledTimes(2);
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("cools down repeated managed Chrome launch failures across route contexts", async () => {
    const { freshProfile } = setupEnsureBrowserAvailableHarness();
    chrome.launch.mockRejectedValue(new Error("Failed to start Chrome CDP"));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(freshProfile().ensureBrowserAvailable()).rejects.toThrow(
        "Failed to start Chrome CDP",
      );
    }

    const cooledDown = freshProfile();
    await expect(cooledDown.ensureBrowserAvailable()).rejects.toThrow(
      'Browser launch for profile "openclaw" is cooling down after 3 consecutive managed Chrome launch failures.',
    );
    await expect(cooledDown.ensureBrowserAvailable()).rejects.toThrow(
      "set browser.enabled=false if the browser tool is not needed",
    );

    expect(chrome.launch).toHaveBeenCalledTimes(3);
    expect(chrome.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(cooledDown.ensureBrowserAvailable()).rejects.toThrow("Failed to start Chrome CDP");
    expect(chrome.launch).toHaveBeenCalledTimes(4);
  });

  it("does not let no-display preflight failures block explicit headless recovery", async () => {
    const { runtime, freshProfile } = setupEnsureBrowserAvailableHarness();
    chrome.launch.mockRejectedValue(
      new BrowserProfileUnavailableError("display required", {
        metadata: {
          reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
          details: {
            profile: "openclaw",
            requestedHeadless: false,
            headlessSource: "config",
            displayPresent: false,
          },
        },
      }),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(freshProfile().ensureBrowserAvailable()).rejects.toThrow("display required");
    }

    mockLaunchedChrome(chrome.launch, 987);
    const recovery = freshProfile().ensureBrowserAvailable({ headless: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(recovery).resolves.toBeUndefined();

    expect(chrome.launch).toHaveBeenCalledTimes(4);
    expect(chrome.launch.mock.calls.at(-1)?.[2]).toMatchObject({
      headlessOverride: true,
      signal: expect.any(AbortSignal),
    });
    expect(runtime.managedLaunchFailure).toBeUndefined();
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("reuses a pre-existing loopback browser after an initial short probe miss", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    state.resolved.ssrfPolicy = {};

    chrome.reachable.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    chrome.ready.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(chrome.reachable.mock.calls).toEqual(
      [300, PROFILE_ATTACH_RETRY_TIMEOUT_MS].map((timeout) => [
        "http://127.0.0.1:18800",
        timeout,
        undefined,
        expect.any(AbortSignal),
      ]),
    );
    expectNoProcessChanges();
  });

  it("explains attachOnly for externally managed loopback CDP services", async () => {
    const { profile } = setupEnsureBrowserAvailableHarness();

    chrome.reachable.mockResolvedValue(true);
    chrome.ready.mockResolvedValue(false);

    const promise = profile.ensureBrowserAvailable();
    await expect(promise).rejects.toThrow(
      'Port 18800 is in use for profile "openclaw" but not by openclaw.',
    );
    await expect(promise).rejects.toThrow(
      "set browser.profiles.openclaw.attachOnly=true so OpenClaw attaches without trying to manage the local process",
    );
    await expect(promise).rejects.toThrow(
      "For Browserless Docker, set EXTERNAL to the same WebSocket endpoint OpenClaw can reach via browser.profiles.<name>.cdpUrl.",
    );

    expectNoProcessChanges();
  });

  it("retries remote CDP websocket reachability once before failing", async () => {
    const { state, profile } = setupEnsureBrowserAvailableHarness({
      resolvedOverrides: {
        profiles: { openclaw: { cdpUrl: "ws://browserless:3001", color: "#00AA00" } },
      },
    });
    chrome.reachable.mockResolvedValueOnce(true);
    chrome.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(chrome.reachable).toHaveBeenCalledTimes(1);
    const probeArgs = [
      "ws://browserless:3001",
      state.resolved.remoteCdpTimeoutMs,
      state.resolved.remoteCdpHandshakeTimeoutMs,
      { allowPrivateNetwork: true, allowedHostnames: ["browserless"] },
      { signal: expect.any(AbortSignal) },
    ];
    expect(chrome.ready.mock.calls).toEqual([probeArgs, probeArgs]);
    expectNoProcessChanges();
  });

  it("resolves for attachOnly loopback profile with a bare ws:// cdpUrl when CDP is reachable (#68027)", async () => {
    const { profile, state } = createAttachOnlyLoopbackProfile("ws://127.0.0.1:9222");

    chrome.reachable.mockResolvedValueOnce(true);
    chrome.ready.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(chrome.reachable).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
      expect.any(AbortSignal),
    );
    expect(chrome.ready).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      state.resolved.remoteCdpHandshakeTimeoutMs,
      undefined,
      { signal: expect.any(AbortSignal), onDiagnostic: expect.any(Function) },
    );
    expectNoProcessChanges();
  });

  it("caches external browser mode per observed browser instance", async () => {
    const { profile, state, runtime } = createAttachOnlyLoopbackProfile("http://127.0.0.1:9222");
    chrome.reachable.mockResolvedValue(true);
    chrome.ready
      .mockImplementationOnce(diagnosticReady("http://127.0.0.1:9222", "A"))
      .mockImplementationOnce(diagnosticReady("http://127.0.0.1:9222", "A"))
      .mockImplementationOnce(diagnosticReady("http://127.0.0.1:9222", "B"));
    chrome.inspectMode.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await profile.ensureBrowserAvailable();
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(false);

    await profile.ensureBrowserAvailable();
    expect(chrome.inspectMode).toHaveBeenCalledTimes(1);

    await profile.ensureBrowserAvailable();
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(true);
    expect(chrome.inspectMode).toHaveBeenCalledTimes(2);

    await beginProfileTransition({ state, runtime, reason: "test browser mode cache reset" });
    expect(runtime.externalBrowserMode).toBeUndefined();
  });

  it("redacts credentials in remote CDP availability errors", async () => {
    const { profile } = setupEnsureBrowserAvailableHarness({
      profile: makeBrowserProfile({
        name: "remote",
        cdpUrl: "https://user:pass@browserless.example.com?token=supersecret123",
        cdpHost: "browserless.example.com",
        cdpIsLoopback: false,
        cdpPort: 443,
      }),
      resolvedOverrides: { ssrfPolicy: {} },
    });
    chrome.reachable.mockResolvedValue(false);

    const promise = profile.ensureBrowserAvailable();
    await expect(promise).rejects.toThrow(BrowserProfileUnavailableError);
    await expect(promise).rejects.toThrow(
      'Remote CDP for profile "remote" is not reachable at https://browserless.example.com/?token=***.',
    );

    expectNoProcessChanges();
  });
});

function createAvailability() {
  const profile = makeBrowserProfile({ attachOnly: true });
  const state = makeBrowserServerState({ profile });
  const runtime: ProfileRuntimeState = { profile, running: null };
  state.profiles.set(profile.name, runtime);
  const availability = createProfileAvailability({
    opts: { getState: () => state },
    profile,
    state: () => state,
    runtime,
  });
  chrome.ready.mockImplementation(diagnosticReady(profile.cdpUrl, "synthetic"));
  return { availability, runtime, state };
}

describe("external browser mode availability", () => {
  it("observes the mode again on the next request after an inconclusive inspection", async () => {
    const { availability, runtime } = createAvailability();
    chrome.inspectMode.mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);

    await expect(availability.isReachable()).resolves.toBe(true);
    await expect(availability.isReachable()).resolves.toBe(true);
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(false);
    expect(chrome.inspectMode).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared observation alive when its first caller cancels", async () => {
    const { availability, runtime } = createAvailability();
    const observation = Promise.withResolvers<boolean>();
    const observing = Promise.withResolvers<AbortSignal | undefined>();
    chrome.inspectMode.mockImplementation(({ signal }) => {
      observing.resolve(signal);
      return observation.promise;
    });
    const caller = new AbortController();
    const first = availability.isReachable(undefined, { signal: caller.signal });
    const rejected = expect(first).rejects.toThrow("cancel first caller");
    const ownerSignal = await observing.promise;
    const secondReady = vi.fn();
    const second = availability.isReachable().then(secondReady);
    await setImmediate();
    expect(secondReady).not.toHaveBeenCalled();
    caller.abort(new Error("cancel first caller"));
    await rejected;
    expect(ownerSignal?.aborted).toBe(false);

    observation.resolve(false);
    await second;
    expect(secondReady).toHaveBeenCalledWith(true);
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(false);
    expect(chrome.inspectMode).toHaveBeenCalledTimes(1);
  });

  it("aborts the observation and clears its cache on a profile transition", async () => {
    const { availability, runtime, state } = createAvailability();
    const observing = Promise.withResolvers<void>();
    chrome.inspectMode.mockImplementation(({ signal }) => {
      observing.resolve();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("mode observation aborted", { cause: signal.reason })),
          { once: true },
        );
      });
    });
    const pending = availability.isReachable();
    const rejected = expect(pending).rejects.toThrow("mode observation aborted");
    await observing.promise;
    await beginProfileTransition({
      state,
      runtime,
      reason: "test transition",
      closeSharedAdapters: false,
    });
    await rejected;
    expect(runtime.externalBrowserMode).toBeUndefined();
  });
});
