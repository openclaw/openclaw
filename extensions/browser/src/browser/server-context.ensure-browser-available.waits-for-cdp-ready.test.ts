import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const PROFILE_HTTP_REACHABILITY_TIMEOUT_MS = 300;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeRunning(pid: number): RunningChrome {
  return {
    pid,
    exe: { kind: "chromium", path: "/usr/bin/chromium" },
    userDataDir: "/tmp/openclaw-test",
    cdpPort: 18800,
    proc: new EventEmitter() as unknown as ChildProcessWithoutNullStreams,
  };
}

function setupEnsureBrowserAvailableHarness() {
  vi.useFakeTimers();

  const launchOpenClawChrome = vi.mocked(chromeModule.launchOpenClawChrome);
  const stopOpenClawChrome = vi.mocked(chromeModule.stopOpenClawChrome);
  const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
  const isChromeCdpOwnedByPid = vi.mocked(chromeModule.isChromeCdpOwnedByPid);
  const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
  isChromeReachable.mockResolvedValue(false);
  isChromeCdpOwnedByPid.mockResolvedValue(true);

  const state = makeBrowserServerState();
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profile = ctx.forProfile("openclaw");

  return {
    launchOpenClawChrome,
    stopOpenClawChrome,
    isChromeCdpOwnedByPid,
    isChromeCdpReady,
    profile,
    state,
  };
}

function createAttachOnlyLoopbackProfile(cdpUrl: string) {
  const state = makeBrowserServerState({
    profile: makeBrowserProfile({
      name: "manual-cdp",
      cdpUrl,
      cdpPort: 9222,
      attachOnly: true,
    }),
    resolvedOverrides: {
      defaultProfile: "manual-cdp",
      ssrfPolicy: {},
    },
  });
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { profile: ctx.forProfile("manual-cdp"), state };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser server-context ensureBrowserAvailable", () => {
  it("keeps a shared launch running when one caller cancels its wait", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state } =
      setupEnsureBrowserAvailableHarness();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const entered = deferred<void>();
    const launch = deferred<RunningChrome>();
    const running = fakeRunning(1200);
    launchOpenClawChrome.mockImplementationOnce(async () => {
      entered.resolve();
      return await launch.promise;
    });
    isChromeCdpReady.mockResolvedValue(true);

    const first = profile.ensureBrowserAvailable({ signal: controller.signal });
    const second = createBrowserRouteContext({ getState: () => state })
      .forProfile()
      .ensureBrowserAvailable();
    await entered.promise;
    const cancelled = expect(first).rejects.toBe(reason);
    controller.abort(reason);
    await cancelled;
    launch.resolve(running);
    await expect(second).resolves.toBeUndefined();

    expect(state.profiles.get("openclaw")?.running).toBe(running);
    expect(launchOpenClawChrome).toHaveBeenCalledOnce();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("rejects and cleans a deferred launch before stop returns, then allows restart", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state } =
      setupEnsureBrowserAvailableHarness();
    const deferredLaunch = deferred<RunningChrome>();
    const launchEntered = deferred<void>();
    const late = fakeRunning(1201);
    const replacement = fakeRunning(1202);
    launchOpenClawChrome
      .mockImplementationOnce(async () => {
        launchEntered.resolve();
        return await deferredLaunch.promise;
      })
      .mockResolvedValueOnce(replacement);
    isChromeCdpReady.mockResolvedValue(true);

    const start = profile.ensureBrowserAvailable();
    await launchEntered.promise;
    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    const stopping = profile.stopRunningBrowser();
    deferredLaunch.resolve(late);

    await expect(start).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(stopOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(stopOpenClawChrome).toHaveBeenCalledWith(late);
    expect(state.profiles.get("openclaw")?.running).toBeNull();
    const runtime = state.profiles.get("openclaw");
    expect(runtime ? getProfileLifecycle(runtime).handles.size : 0).toBe(0);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    expect(state.profiles.get("openclaw")?.running).toBe(replacement);
  });

  it("does not count canceled managed starts toward the launch cooldown", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValue(true);
    const runtime = state.profiles.get("openclaw");
    if (!runtime) {
      throw new Error("expected openclaw runtime");
    }
    const previousFailure = {
      consecutiveFailures: 2,
      lastError: "earlier launch failure",
    };
    runtime.managedLaunchFailure = previousFailure;
    const launchEntered = deferred<void>();
    const deferredLaunch = deferred<RunningChrome>();
    launchOpenClawChrome.mockImplementationOnce(async () => {
      launchEntered.resolve();
      return await deferredLaunch.promise;
    });

    const start = profile.ensureBrowserAvailable();
    await launchEntered.promise;
    const canceling = beginProfileTransition({
      state,
      runtime,
      reason: "profile config changed",
    });
    deferredLaunch.resolve(fakeRunning(1300));

    await expect(start).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(canceling).resolves.toEqual({ stopped: true });
    expect(runtime.managedLaunchFailure).toBe(previousFailure);

    const replacement = fakeRunning(1400);
    launchOpenClawChrome.mockResolvedValueOnce(replacement);
    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(2);
    expect(stopOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(state.profiles.get("openclaw")?.running).toBe(replacement);
    expect(state.profiles.get("openclaw")?.managedLaunchFailure).toBeUndefined();
  });

  it("keeps Chrome across startup and later operations when readiness responses take 750ms", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockImplementation(
      async (_url, timeoutMs = 0) =>
        await new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(timeoutMs >= 750), Math.min(750, timeoutMs));
        }),
    );
    const launched = mockLaunchedChrome(launchOpenClawChrome, 124);

    const ready = expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(8100);
    await ready;

    vi.mocked(chromeModule.isChromeReachable).mockImplementation(async () =>
      Boolean(state.profiles.get("openclaw")?.running),
    );
    const reused = expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(8100);
    await reused;

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(state.profiles.get("openclaw")?.running).toBe(launched);
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("stops launched chrome when CDP readiness never arrives", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state } =
      setupEnsureBrowserAvailableHarness();
    state.resolved.localCdpReadyTimeoutMs = 250;
    isChromeCdpReady.mockResolvedValue(false);
    mockLaunchedChrome(launchOpenClawChrome, 321);

    const promise = profile.ensureBrowserAvailable();
    const rejected = expect(promise).rejects.toThrow("not reachable after start");
    const diagnosticRejected = expect(promise).rejects.toThrow(
      "CDP diagnostic: websocket_health_command_timeout; mock CDP diagnostic.",
    );
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    await diagnosticRejected;

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(stopOpenClawChrome).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign listener that wins the managed CDP port after spawn", async () => {
    const {
      launchOpenClawChrome,
      stopOpenClawChrome,
      isChromeCdpOwnedByPid,
      isChromeCdpReady,
      profile,
      state,
    } = setupEnsureBrowserAvailableHarness();
    const launched = fakeRunning(1234);
    launchOpenClawChrome.mockResolvedValue(launched);
    isChromeCdpReady.mockResolvedValue(true);
    isChromeCdpOwnedByPid.mockResolvedValue(false);

    await expect(profile.ensureBrowserAvailable()).rejects.toThrow("did not own its CDP endpoint");

    expect(isChromeCdpOwnedByPid).toHaveBeenCalledWith(
      "http://127.0.0.1:18800",
      launched.pid,
      expect.any(Number),
      undefined,
      expect.any(AbortSignal),
    );
    expect(stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(launched);
    expect(state.profiles.get("openclaw")?.running).toBeNull();
  });

  it("does not adopt a managed child that exits during the ownership probe", async () => {
    const {
      launchOpenClawChrome,
      stopOpenClawChrome,
      isChromeCdpOwnedByPid,
      isChromeCdpReady,
      profile,
      state,
    } = setupEnsureBrowserAvailableHarness();
    const launched = fakeRunning(1235);
    const ownershipEntered = deferred<void>();
    const ownership = deferred<boolean>();
    launchOpenClawChrome.mockResolvedValue(launched);
    isChromeCdpReady.mockResolvedValue(true);
    isChromeCdpOwnedByPid.mockImplementationOnce(async () => {
      ownershipEntered.resolve();
      return await ownership.promise;
    });

    const start = profile.ensureBrowserAvailable();
    await ownershipEntered.promise;
    launched.proc.emit("exit", 0, null);
    ownership.resolve(true);

    await expect(start).rejects.toThrow("exited before adoption");
    const runtime = state.profiles.get("openclaw");
    expect(runtime?.running).toBeNull();
    expect(runtime ? getProfileLifecycle(runtime).handles.size : 0).toBe(0);
    expect(stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(launched);
  });

  it("passes request-local headless override to the owned restart path", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state } =
      setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    const runtime = state.profiles.get("openclaw");
    if (!runtime) {
      throw new Error("expected openclaw runtime");
    }
    runtime.running = fakeRunning(111);
    isChromeReachable.mockImplementation(async () => Boolean(runtime.running));
    isChromeCdpReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockLaunchedChrome(launchOpenClawChrome, 987);

    await expect(profile.ensureBrowserAvailable({ headless: true })).resolves.toBeUndefined();

    expect(stopOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(launchOpenClawChrome.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ headlessOverride: true, signal: expect.any(AbortSignal) }),
    );
  });

  it("clears the concurrent lazy-start guard after launch failure", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValue(true);
    launchOpenClawChrome.mockRejectedValueOnce(
      new Error("PortInUseError: listen EADDRINUSE 127.0.0.1:18800"),
    );

    const first = profile.ensureBrowserAvailable();
    const second = profile.ensureBrowserAvailable();
    await expect(Promise.all([first, second])).rejects.toThrow("PortInUseError");

    mockLaunchedChrome(launchOpenClawChrome, 789);
    const retry = profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(100);
    await expect(retry).resolves.toBeUndefined();

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(2);
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("cools down repeated managed Chrome launch failures across route contexts", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, state } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValue(true);
    launchOpenClawChrome.mockRejectedValue(new Error("Failed to start Chrome CDP"));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ctx = createBrowserRouteContext({ getState: () => state });
      await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
        "Failed to start Chrome CDP",
      );
    }

    const cooledDownCtx = createBrowserRouteContext({ getState: () => state });
    await expect(cooledDownCtx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      'Browser launch for profile "openclaw" is cooling down after 3 consecutive managed Chrome launch failures.',
    );
    await expect(cooledDownCtx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      "set browser.enabled=false if the browser tool is not needed",
    );

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(3);
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(cooledDownCtx.forProfile().ensureBrowserAvailable()).rejects.toThrow(
      "Failed to start Chrome CDP",
    );
    expect(launchOpenClawChrome).toHaveBeenCalledTimes(4);
  });

  it("does not let no-display preflight failures block explicit headless recovery", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, state } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValue(true);
    launchOpenClawChrome.mockRejectedValue(
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
      const ctx = createBrowserRouteContext({ getState: () => state });
      await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
        "display required",
      );
    }

    mockLaunchedChrome(launchOpenClawChrome, 987);
    const recoveryCtx = createBrowserRouteContext({ getState: () => state });
    const recovery = recoveryCtx.forProfile("openclaw").ensureBrowserAvailable({ headless: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(recovery).resolves.toBeUndefined();

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(4);
    expect(launchOpenClawChrome.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({ headlessOverride: true, signal: expect.any(AbortSignal) }),
    );
    expect(state.profiles.get("openclaw")?.managedLaunchFailure).toBeUndefined();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("reuses a pre-existing loopback browser after an initial short probe miss", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile, state } =
      setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    state.resolved.ssrfPolicy = {};

    isChromeReachable.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    isChromeCdpReady.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(isChromeReachable).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:18800",
      PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
      undefined,
      expect.any(AbortSignal),
    );
    expect(isChromeReachable).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:18800",
      PROFILE_ATTACH_RETRY_TIMEOUT_MS,
      undefined,
      expect.any(AbortSignal),
    );
    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("explains attachOnly for externally managed loopback CDP services", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);

    isChromeReachable.mockResolvedValue(true);
    isChromeCdpReady.mockResolvedValue(false);

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

    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("retries remote CDP websocket reachability once before failing", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady } =
      setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);

    const state = makeBrowserServerState();
    state.resolved.profiles.openclaw = {
      cdpUrl: "ws://browserless:3001",
      color: "#00AA00",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("openclaw");
    const expectedRemoteHttpTimeoutMs = state.resolved.remoteCdpTimeoutMs;
    const expectedRemoteWsTimeoutMs = state.resolved.remoteCdpHandshakeTimeoutMs;

    isChromeReachable.mockResolvedValueOnce(true);
    isChromeCdpReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(isChromeReachable).toHaveBeenCalledTimes(1);
    expect(isChromeCdpReady).toHaveBeenCalledTimes(2);
    expect(isChromeCdpReady).toHaveBeenNthCalledWith(
      1,
      "ws://browserless:3001",
      expectedRemoteHttpTimeoutMs,
      expectedRemoteWsTimeoutMs,
      {
        allowPrivateNetwork: true,
        allowedHostnames: ["browserless"],
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(isChromeCdpReady).toHaveBeenNthCalledWith(
      2,
      "ws://browserless:3001",
      expectedRemoteHttpTimeoutMs,
      expectedRemoteWsTimeoutMs,
      {
        allowPrivateNetwork: true,
        allowedHostnames: ["browserless"],
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("resolves for attachOnly loopback profile with a bare ws:// cdpUrl when CDP is reachable (#68027)", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome } = setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);

    const { profile, state } = createAttachOnlyLoopbackProfile("ws://127.0.0.1:9222");

    isChromeReachable.mockResolvedValueOnce(true);
    isChromeCdpReady.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(isChromeReachable).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
      expect.any(AbortSignal),
    );
    expect(isChromeCdpReady).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      state.resolved.remoteCdpHandshakeTimeoutMs,
      undefined,
      { signal: expect.any(AbortSignal), onDiagnostic: expect.any(Function) },
    );
    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("caches external browser mode per observed browser instance", async () => {
    setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
    const inspectLocalChromeHeadlessMode = vi.mocked(chromeModule.inspectLocalChromeHeadlessMode);
    const { profile, state } = createAttachOnlyLoopbackProfile("http://127.0.0.1:9222");
    const emitDiagnostic =
      (wsUrl: string) =>
      async (...args: Parameters<typeof chromeModule.isChromeCdpReady>): Promise<boolean> => {
        await args[4]?.onDiagnostic?.({
          ok: true,
          cdpUrl: "http://127.0.0.1:9222",
          wsUrl,
          browser: "Chrome/151.0.0.0",
          elapsedMs: 1,
        });
        return true;
      };

    isChromeReachable.mockResolvedValue(true);
    isChromeCdpReady
      .mockImplementationOnce(emitDiagnostic("ws://127.0.0.1:9222/devtools/browser/A"))
      .mockImplementationOnce(emitDiagnostic("ws://127.0.0.1:9222/devtools/browser/A"))
      .mockImplementationOnce(emitDiagnostic("ws://127.0.0.1:9222/devtools/browser/B"));
    inspectLocalChromeHeadlessMode.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await profile.ensureBrowserAvailable();
    const runtime = state.profiles.get("manual-cdp");
    await expect(runtime?.externalBrowserMode?.headless).resolves.toBe(false);

    await profile.ensureBrowserAvailable();
    expect(inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(1);

    await profile.ensureBrowserAvailable();
    await expect(runtime?.externalBrowserMode?.headless).resolves.toBe(true);
    expect(inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(2);

    if (!runtime) {
      throw new Error("expected manual-cdp runtime");
    }
    await beginProfileTransition({ state, runtime, reason: "test browser mode cache reset" });
    expect(runtime.externalBrowserMode).toBeUndefined();
  });

  it("redacts credentials in remote CDP availability errors", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome } = setupEnsureBrowserAvailableHarness();
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);

    const state = makeBrowserServerState({
      profile: {
        name: "remote",
        cdpUrl: "https://user:pass@browserless.example.com?token=supersecret123",
        cdpHost: "browserless.example.com",
        cdpIsLoopback: false,
        cdpPort: 443,
        color: "#00AA00",
        driver: "openclaw",
        headless: false,
        attachOnly: false,
      },
      resolvedOverrides: {
        defaultProfile: "remote",
        ssrfPolicy: {},
      },
    });
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("remote");

    isChromeReachable.mockResolvedValue(false);

    const promise = profile.ensureBrowserAvailable();
    await expect(promise).rejects.toThrow(BrowserProfileUnavailableError);
    await expect(promise).rejects.toThrow(
      'Remote CDP for profile "remote" is not reachable at https://browserless.example.com/?token=***.',
    );

    expect(launchOpenClawChrome).not.toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
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
    configRevision: 0,
  });
  vi.mocked(chromeModule.isChromeCdpReady).mockImplementation(async (...args) => {
    await args[4]?.onDiagnostic?.({
      ok: true,
      cdpUrl: profile.cdpUrl,
      wsUrl: "ws://127.0.0.1:18800/devtools/browser/synthetic",
      elapsedMs: 1,
    });
    return true;
  });
  return { availability, runtime, state };
}

describe("external browser mode availability", () => {
  it("observes the mode again on the next request after an inconclusive inspection", async () => {
    const { availability, runtime } = createAvailability();
    vi.mocked(chromeModule.inspectLocalChromeHeadlessMode)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(false);

    await expect(availability.isReachable()).resolves.toBe(true);
    await expect(availability.isReachable()).resolves.toBe(true);
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(false);
    expect(chromeModule.inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared observation alive when its first caller cancels", async () => {
    const { availability, runtime } = createAvailability();
    const observation = deferred<boolean>();
    const observing = deferred<AbortSignal | undefined>();
    vi.mocked(chromeModule.inspectLocalChromeHeadlessMode).mockImplementation(({ signal }) => {
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
    expect(chromeModule.inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(1);
  });

  it("aborts the observation and clears its cache on a profile transition", async () => {
    const { availability, runtime, state } = createAvailability();
    const observing = deferred<void>();
    vi.mocked(chromeModule.inspectLocalChromeHeadlessMode).mockImplementation(({ signal }) => {
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
