import { ChildProcess } from "node:child_process";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  ensureProviderLocalService,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import { hasManagedProviderLocalServices } from "./provider-runtime-lifecycle.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), alive: vi.fn(), signal: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../process/child-process-tree.js", () => ({
  isChildProcessTreeAlive: mocks.alive,
  signalChildProcessTree: mocks.signal,
  forceKillChildProcessTree: mocks.signal,
  shouldDetachChildForProcessTree: () => false,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["child close", "tree signal completion", "already-exited child close"])(
  "keeps provider shutdown owned until %s after PID disappearance",
  async (heldFact) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = new ChildProcess();
    let exitCode: number | null = null;
    Object.defineProperties(child, {
      pid: { value: 12345 },
      exitCode: { get: () => exitCode },
      stdout: { value: null },
      stderr: { value: null },
    });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    mocks.alive.mockReturnValue(true);
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("not started"))
      .mockImplementation(async () => new Response("ready"));
    const signaled = createDeferred();
    let completeSignal: (() => void) | undefined;
    mocks.signal.mockImplementation(
      (_child: ChildProcess, _signal: string, onComplete?: () => void) => {
        completeSignal = onComplete;
        mocks.alive.mockReturnValue(false);
        exitCode = 0;
        child.emit("exit", 0, null);
        if (heldFact === "child close") {
          onComplete?.();
        } else {
          child.emit("close", 0, null);
        }
        signaled.resolve();
      },
    );

    const lease = await ensureProviderLocalService({
      providerId: "settlement-fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      service: { command: process.execPath },
    });
    expect(lease).toBeDefined();
    if (heldFact === "already-exited child close") {
      mocks.alive.mockReturnValue(false);
      exitCode = 0;
      child.emit("exit", 0, null);
      signaled.resolve();
    }
    let settled = false;
    const stopped = stopManagedProviderLocalServices().finally(() => {
      settled = true;
    });
    try {
      await signaled.promise;
      await nextEventLoopTurn();
      expect(settled).toBe(false);
      expect(hasManagedProviderLocalServices()).toBe(true);
    } finally {
      child.emit("close", 0, null);
      completeSignal?.();
      await vi.runAllTimersAsync();
      await stopped;
      lease?.release();
    }
    expect(hasManagedProviderLocalServices()).toBe(false);
  },
);

it("does not regain Windows PID authority during shutdown retry before child exit", async () => {
  await withMockedPlatform("win32", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const child = new ChildProcess();
    let exitCode: number | null = null;
    Object.defineProperties(child, {
      pid: { value: 12345 },
      exitCode: { get: () => exitCode },
      stdout: { value: null },
      stderr: { value: null },
    });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    mocks.alive.mockReset().mockReturnValue(true);
    mocks.signal
      .mockReset()
      .mockImplementation((_child: ChildProcess, _signal: string, onComplete?: () => void) =>
        onComplete?.(),
      );
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("not started"))
      .mockImplementation(async () => new Response("ready"));
    const lease = await ensureProviderLocalService({
      providerId: "windows-pid-authority-fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      service: { command: process.execPath },
    });
    expect(lease).toBeDefined();
    mocks.alive.mockClear().mockReturnValueOnce(false).mockReturnValue(true);
    const stopped = stopManagedProviderLocalServices();
    const rejected = expect(stopped).rejects.toThrow(
      "Local model service process tree 12345 did not stop",
    );
    let retried: Promise<void> | undefined;
    try {
      await nextEventLoopTurn();
      expect(mocks.alive).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_000);
      await rejected;
      expect(mocks.signal).not.toHaveBeenCalled();
      expect(hasManagedProviderLocalServices()).toBe(true);

      retried = stopManagedProviderLocalServices();
      await nextEventLoopTurn();
      expect(mocks.signal).not.toHaveBeenCalled();
      expect(hasManagedProviderLocalServices()).toBe(true);
    } finally {
      mocks.alive.mockReturnValue(false);
      exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      const cleanup = stopManagedProviderLocalServices();
      await vi.runAllTimersAsync();
      await cleanup;
      await retried;
      lease?.release();
    }
    expect(hasManagedProviderLocalServices()).toBe(false);
  });
});
