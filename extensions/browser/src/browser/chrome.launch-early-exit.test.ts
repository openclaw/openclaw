import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserConfig, type ResolvedBrowserProfile } from "./config.js";

const { spawnMock, readVersionMock, diagnoseMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  readVersionMock: vi.fn(),
  diagnoseMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>()),
  ensurePortAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./chrome.diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.diagnostics.js")>()),
  readChromeVersionWithCredentialFallback: readVersionMock,
  diagnoseChromeCdp: diagnoseMock,
}));
vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp.helpers.js")>()),
  assertCdpEndpointAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./cdp-proxy-bypass.js", () => ({
  assertManagedProxyAllowsCdpUrl: vi.fn(),
}));
vi.mock("./chrome.executables.js", () => ({
  resolveBrowserExecutableForPlatform: () => ({ kind: "custom", path: "/synthetic/chrome" }),
}));
vi.mock("./output-directories.js", () => ({ ensureOutputDirectory: vi.fn() }));
vi.mock("./chrome.profile-decoration.js", () => ({
  isProfileDecorated: () => true,
  usesOpenClawMockKeychain: () => false,
  ensureProfileCleanExit: vi.fn(),
  ensureProfileNetworkPredictionDisabled: vi.fn(),
  decorateOpenClawProfile: vi.fn(),
}));

import { launchOpenClawChrome, ManagedChromeCleanupError } from "./chrome.js";

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
const profile = {
  name: "synthetic-early-exit",
  cdpPort: 51114,
  cdpUrl: "http://127.0.0.1:51114",
  cdpIsLoopback: true,
  headless: true,
  color: "#FF4500",
} as ResolvedBrowserProfile;
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
