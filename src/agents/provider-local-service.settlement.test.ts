import { ChildProcess } from "node:child_process";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as processTree from "../process/child-process-tree.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  ensureProviderLocalService,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import {
  hasManagedProviderLocalServices,
  stopActiveManagedProviderLocalServices,
} from "./provider-runtime-lifecycle.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
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
    const alive = vi.spyOn(processTree, "isChildProcessTreeAlive").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("not started"))
      .mockImplementation(async () => new Response("ready"));
    const signaled = createDeferred();
    let completeSignal: (() => void) | undefined;
    vi.spyOn(processTree, "signalChildProcessTree").mockImplementation(
      (_child, _signal, onComplete) => {
        completeSignal = onComplete;
        alive.mockReturnValue(false);
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
      alive.mockReturnValue(false);
      exitCode = 0;
      child.emit("exit", 0, null);
      signaled.resolve();
    }
    let settled = false;
    const stopped = stopActiveManagedProviderLocalServices().finally(() => {
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
    const alive = vi.spyOn(processTree, "isChildProcessTreeAlive").mockReturnValue(true);
    const signal = vi
      .spyOn(processTree, "signalChildProcessTree")
      .mockImplementation((_child, _signal, onComplete) => onComplete?.());
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("not started"))
      .mockImplementation(async () => new Response("ready"));
    const lease = await ensureProviderLocalService({
      providerId: "windows-pid-authority-fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      service: { command: process.execPath },
    });
    expect(lease).toBeDefined();
    alive.mockClear().mockReturnValueOnce(false).mockReturnValue(true);
    const stopped = stopManagedProviderLocalServices();
    const rejected = expect(stopped).rejects.toThrow(
      "Local model service process tree 12345 did not stop",
    );
    let retried: Promise<void> | undefined;
    try {
      await nextEventLoopTurn();
      expect(alive).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_000);
      await rejected;
      expect(signal).not.toHaveBeenCalled();
      expect(hasManagedProviderLocalServices()).toBe(true);

      retried = stopManagedProviderLocalServices();
      await nextEventLoopTurn();
      expect(signal).not.toHaveBeenCalled();
      expect(hasManagedProviderLocalServices()).toBe(true);
    } finally {
      alive.mockReturnValue(false);
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

it.each([
  { completion: "late helper close", forcedDurationMs: 2_500 },
  { completion: "bounded helper timeout", forcedDurationMs: 3_000 },
])("joins Windows shutdown until $completion", async ({ completion, forcedDurationMs }) => {
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
    let forcedHelper: ChildProcess | undefined;
    mocks.spawn.mockImplementation((command: string, args: string[]) => {
      if (command === process.execPath) {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }
      if (command !== "taskkill") {
        throw new Error(`Unexpected fixture command: ${command}`);
      }
      const helper = new ChildProcess();
      if (args.includes("/F")) {
        forcedHelper = helper;
        queueMicrotask(() => {
          exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      } else {
        // An unforced taskkill refuses a Node console process without stopping it.
        queueMicrotask(() => helper.emit("close", 1));
      }
      return helper;
    });
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== child.pid || signal !== 0) {
        throw new Error("Unexpected fixture process probe");
      }
      if (child.exitCode !== null) {
        throw Object.assign(new Error("Fixture service exited"), { code: "ESRCH" });
      }
      return true;
    });
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("not started"))
      .mockImplementation(async () => new Response("ready"));
    const lease = await ensureProviderLocalService({
      providerId: "windows-helper-settlement-fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      service: { command: process.execPath },
    });
    expect(lease).toBeDefined();
    let outcome: unknown = "pending";
    const stopped = stopActiveManagedProviderLocalServices().then(
      () => {
        outcome = "fulfilled";
      },
      (error: unknown) => {
        outcome = error;
        throw error;
      },
    );
    void stopped.catch(() => {});
    try {
      // Two-second grace + two-second exit observation must not outrun the
      // real taskkill owner's three-second completion contract.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(child.exitCode).toBe(0);
      expect(outcome).toBe("pending");
      expect(hasManagedProviderLocalServices()).toBe(true);

      await vi.advanceTimersByTimeAsync(forcedDurationMs - 2_001);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      if (completion === "late helper close") {
        forcedHelper?.emit("close", 0);
      }
      await stopped;
      expect(hasManagedProviderLocalServices()).toBe(false);
    } finally {
      exitCode = 0;
      child.emit("close", 0, null);
      forcedHelper?.emit("close", 0);
      const cleanup = stopManagedProviderLocalServices();
      await vi.runAllTimersAsync();
      await cleanup;
      lease?.release();
    }
  });
});
