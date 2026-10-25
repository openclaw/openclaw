import type * as ChildProcessModule from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type * as TimerPromises from "node:timers/promises";
import type * as SecurityRuntime from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CdpHelpers from "./cdp.helpers.js";
import type * as ChromeDiagnostics from "./chrome.diagnostics.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveBrowserConfig } from "./config.js";

const { spawnMock, readVersionMock, diagnoseMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  readVersionMock: vi.fn(),
  diagnoseMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: spawnMock,
}));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimerPromises>()),
  // Promise-based polling must share the fake clock installed before each test.
  setTimeout: (delayMs = 0, value?: unknown, options?: { signal?: AbortSignal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const signal = options?.signal;
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(value);
    }, delayMs);
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
    return promise;
  },
}));
vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SecurityRuntime>()),
  ensurePortAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./chrome.diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ChromeDiagnostics>()),
  readChromeVersionWithCredentialFallback: readVersionMock,
  diagnoseChromeCdp: diagnoseMock,
}));
vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CdpHelpers>()),
  assertCdpEndpointAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./cdp-proxy-bypass.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp-proxy-bypass.js")>()),
  assertManagedProxyAllowsCdpUrl: vi.fn(),
}));
vi.mock("./chrome.executables.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.executables.js")>()),
  assertBrowserExecutableSupportsLaunch: vi.fn(),
  processCommandUsesHeadlessChrome: () => false,
  resolveBrowserExecutableForPlatform: () => ({ kind: "custom", path: "/synthetic/chrome" }),
}));
vi.mock("./output-directories.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./output-directories.js")>()),
  ensureOutputDirectory: vi.fn(),
}));
vi.mock("./chrome.profile-decoration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.profile-decoration.js")>()),
  usesOpenClawMockKeychain: () => false,
  prepareOpenClawProfile: vi.fn(),
}));
// Keep process-discovery timing independent of cross-process profile-lock I/O.
vi.mock("./chrome.profile-lifecycle-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.profile-lifecycle-lock.js")>()),
  withChromeProfileLifecycleLock: <T>(_profile: string, run: () => Promise<T>) => run(),
}));

import { launchOpenClawChrome, ManagedChromeCleanupError } from "./chrome.js";
import { prepareOpenClawProfile } from "./chrome.profile-decoration.js";

function makeProc() {
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stderr: new EventEmitter(),
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.signalCode = signal;
      proc.emit("exit", null, signal);
      return true;
    }),
  });
  return proc;
}

const resolved = {
  ...resolveBrowserConfig({ headless: true, noSandbox: true, extraArgs: [] }),
  localLaunchTimeoutMs: 15_000,
};
const profile: ResolvedBrowserProfile = {
  name: "synthetic-early-exit",
  cdpPort: 51114,
  cdpUrl: "http://127.0.0.1:51114",
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  driver: "openclaw",
  attachOnly: false,
  headless: true,
  color: "#FF4500",
};
const readyVersion = { webSocketDebuggerUrl: "ws://127.0.0.1:51114/devtools/browser/fixture" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
  vi.spyOn(fs, "readlinkSync").mockImplementation(() => {
    throw Object.assign(new Error("synthetic missing profile lock"), { code: "ENOENT" });
  });
  readVersionMock.mockRejectedValue(new Error("synthetic unavailable CDP"));
  diagnoseMock.mockResolvedValue({
    ok: false,
    code: "http_unreachable",
    cdpUrl: profile.cdpUrl,
    elapsedMs: 0,
    message: "synthetic unavailable CDP",
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("managed Chrome early child exit", () => {
  it("does not spawn after cancellation while preparing the profile", async () => {
    const preparation = Promise.withResolvers<void>();
    vi.mocked(prepareOpenClawProfile).mockReturnValueOnce(preparation.promise);
    const controller = new AbortController();
    const reason = new Error("synthetic profile preparation cancellation");
    const outcome = launchOpenClawChrome(resolved, profile, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(prepareOpenClawProfile).toHaveBeenCalledOnce());
    controller.abort(reason);
    preparation.resolve();
    expect(await outcome).toBe(reason);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("cancels the bounded stderr drain without retaining listeners", async () => {
    const proc = makeProc();
    proc.exitCode = 23;
    const controller = new AbortController();
    const reason = new Error("synthetic drain cancellation");
    spawnMock.mockImplementation(() => {
      setTimeout(() => controller.abort(reason), 25);
      return proc;
    });
    const outcome = launchOpenClawChrome(resolved, profile, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(reason);
    expect(proc.stderr.listenerCount("data")).toBe(0);
    expect(proc.stderr.listenerCount("close")).toBe(0);
    expect(proc.stderr.listenerCount("error")).toBe(0);
  });

  it("keeps stderr buffered until shortly after the child exit", async () => {
    const proc = makeProc();
    proc.exitCode = 23;
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        proc.stderr.emit("data", "synthetic delayed newest stderr");
        proc.stderr.emit("close");
      }, 25);
      return proc;
    });
    const outcome = launchOpenClawChrome(resolved, profile).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(String(await outcome)).toContain("synthetic delayed newest stderr");
    expect(proc.stderr.listenerCount("data")).toBe(0);
    expect(proc.stderr.listenerCount("close")).toBe(0);
  });

  it.each([
    { exitCode: 0, signalCode: null },
    { exitCode: 23, signalCode: null },
    { exitCode: null, signalCode: "SIGTERM" as const },
  ])("stops discovery for exit $exitCode / $signalCode", async (exit) => {
    const proc = Object.assign(makeProc(), exit);
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => proc.stderr.emit("data", "synthetic newest stderr"));
      return proc;
    });
    let settled = false;
    const outcome = launchOpenClawChrome(resolved, profile).catch((error: unknown) => error);
    void outcome.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    const settledPromptly = settled;
    // Drain the original implementation too, so the RED replay leaves no timer behind.
    await vi.runAllTimersAsync();
    const error = await outcome;
    expect(settledPromptly).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("exited before CDP became ready");
    expect(String(error)).toContain("synthetic newest stderr");
    expect(readVersionMock).not.toHaveBeenCalled();
    expect(diagnoseMock).not.toHaveBeenCalled();
    expect(proc.stderr.listenerCount("data")).toBe(0);
  });

  it.each([false, true])("rejects an exit while readiness returns %s", async (reachable) => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    readVersionMock.mockImplementation(async () => {
      proc.exitCode = 23;
      proc.emit("exit", 23, null);
      if (!reachable) {
        throw new Error("synthetic unavailable CDP");
      }
      return readyVersion;
    });
    const outcome = launchOpenClawChrome(resolved, profile).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(String(await outcome)).toContain("exited before CDP became ready");
    expect(diagnoseMock).not.toHaveBeenCalled();
    expect(proc.stderr.listenerCount("data")).toBe(0);
  });

  it("rejects a child that exits while the final diagnostic succeeds", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    // Expire discovery before polling so this case owns only the final diagnostic race.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 15_000;
      return now;
    });
    diagnoseMock.mockImplementation(async () => {
      proc.exitCode = 0;
      proc.emit("exit", 0, null);
      return { ok: true, cdpUrl: profile.cdpUrl, elapsedMs: 0 };
    });
    const outcome = launchOpenClawChrome(resolved, profile).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(String(await outcome)).toContain("code 0");
    expect(readVersionMock).not.toHaveBeenCalled();
    expect(diagnoseMock).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation when the child also exits during a probe", async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const controller = new AbortController();
    const reason = new Error("synthetic lifecycle cancellation");
    readVersionMock.mockImplementation(async () => {
      proc.exitCode = 23;
      controller.abort(reason);
      return readyVersion;
    });
    const outcome = launchOpenClawChrome(resolved, profile, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(reason);
    expect(proc.stderr.listenerCount("data")).toBe(0);
  });

  it("retains the exact child when cancellation cleanup does not finish", async () => {
    const proc = makeProc();
    proc.kill.mockReturnValue(false);
    spawnMock.mockReturnValue(proc);
    const controller = new AbortController();
    readVersionMock.mockImplementation(async () => {
      controller.abort(new Error("synthetic cancellation"));
      return readyVersion;
    });
    const outcome = launchOpenClawChrome(resolved, profile, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    const error = await outcome;
    expect(error).toBeInstanceOf(ManagedChromeCleanupError);
    expect(error).toMatchObject({ running: { proc } });
    expect(proc.stderr.listenerCount("data")).toBe(0);
  });
});
