import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const launcherPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/mxc-spawn-launcher.mjs",
);

const loadLauncher = () =>
  require(launcherPath) as {
    decodePayload: (argv: string[]) => unknown;
    forwardSignals: (
      spawned: { kill: (signal: string) => void },
      options?: {
        exitGraceMs?: number;
        setTimeout?: (callback: () => void, ms: number) => { unref?: () => void };
        clearTimeout?: (timer: unknown) => void;
      },
    ) => { exitCode: () => number | undefined; dispose: () => void };
    launchSandbox: (
      spawnSandboxFromConfig: (config: unknown, options: unknown) => unknown,
      config: unknown,
      options: unknown,
      bridges?: {
        child?: (spawned: unknown) => void;
        pty?: (spawned: unknown) => void;
      },
    ) => Promise<void>;
    signalExitCode: (signal: number | string | undefined) => number;
  };

describe("mxc-spawn-launcher", () => {
  it("decodes a JSON --payload-file and removes it before spawning", () => {
    const { decodePayload } = loadLauncher();
    const dir = mkdtempSync(path.join(tmpdir(), "mxc-launcher-test-"));
    const payloadFile = path.join(dir, "payload.json");
    const body = { config: { process: { env: ["SECRET=value"] } }, options: {} };
    try {
      writeFileSync(payloadFile, JSON.stringify(body), "utf-8");

      expect(decodePayload(["--payload-file", payloadFile])).toEqual(body);
      expect(existsSync(payloadFile)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("throws when --payload is missing", () => {
    const { decodePayload } = loadLauncher();

    expect(() => decodePayload([])).toThrow(/Missing --payload-file/);
  });

  it("maps PTY signal exits to process exit codes", () => {
    const { signalExitCode } = loadLauncher();

    expect(signalExitCode(15)).toBe(143);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGUNKNOWN")).toBe(1);
    expect(signalExitCode(undefined)).toBe(1);
  });

  it("resolves a promised PTY before selecting its bridge", async () => {
    const { launchSandbox } = loadLauncher();
    const pty = { onData: vi.fn() };
    const spawnResult = Promise.resolve(pty);
    const ptyBridge = vi.fn();
    const childBridge = vi.fn();

    await launchSandbox(() => spawnResult, { process: {} }, undefined, {
      pty: ptyBridge,
      child: childBridge,
    });

    expect(ptyBridge).toHaveBeenCalledWith(pty);
    expect(ptyBridge).not.toHaveBeenCalledWith(spawnResult);
    expect(childBridge).not.toHaveBeenCalled();
  });

  it("resolves a promised child process before selecting its bridge", async () => {
    const { launchSandbox } = loadLauncher();
    const child = { on: vi.fn(), stdout: undefined, stderr: undefined };
    const spawnResult = Promise.resolve(child);
    const ptyBridge = vi.fn();
    const childBridge = vi.fn();

    await launchSandbox(
      () => spawnResult,
      { process: {} },
      { usePty: false },
      {
        pty: ptyBridge,
        child: childBridge,
      },
    );

    expect(childBridge).toHaveBeenCalledWith(child);
    expect(childBridge).not.toHaveBeenCalledWith(spawnResult);
    expect(ptyBridge).not.toHaveBeenCalled();
  });

  it("forwards process termination signals to spawned sandbox children", () => {
    const { forwardSignals } = loadLauncher();
    const listeners = new Map<string, () => void>();
    const processOn = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (typeof event === "string" && typeof listener === "function") {
        listeners.set(event, listener as () => void);
      }
      return process;
    });
    const spawned = { kill: vi.fn() };
    const clearTimeoutMock = vi.fn();
    const timers: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
    const setTimeoutMock = vi.fn((callback: () => void, ms: number) => {
      const timer = { callback, ms, unref: vi.fn() };
      timers.push(timer);
      return timer;
    });
    try {
      const signals = forwardSignals(spawned, {
        exitGraceMs: 25,
        setTimeout: setTimeoutMock,
        clearTimeout: clearTimeoutMock,
      });

      listeners.get("SIGTERM")?.();
      listeners.get("SIGINT")?.();

      expect(spawned.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawned.kill).toHaveBeenCalledWith("SIGINT");
      expect(setTimeoutMock).toHaveBeenCalledTimes(1);
      expect(timers[0]?.ms).toBe(25);
      expect(timers[0]?.unref).toHaveBeenCalledTimes(1);

      timers[0]?.callback();

      expect(spawned.kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(signals.exitCode()).toBe(143);
      signals.dispose();
      expect(clearTimeoutMock).toHaveBeenCalledWith(timers[0]);
    } finally {
      processOn.mockRestore();
    }
  });

  it("waits for child stdio closure and releases launcher input and signal listeners", async () => {
    const { launchSandbox } = loadLauncher();
    const originalCode = process.exitCode;
    const inputListeners = process.stdin.listeners("data");
    const signalListeners = process.listeners("SIGTERM");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("forced launcher exit");
    });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    let settled = false;
    const running = launchSandbox(() => child, {}, {}).then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      child.emit("exit", 7, null);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 7, null);
      await running;
      expect(process.exitCode).toBe(7);
      expect(process.stdin.listeners("data")).toEqual(inputListeners);
      expect(process.listeners("SIGTERM")).toEqual(signalListeners);
      expect(child.stdin.destroyed).toBe(true);
    } finally {
      child.emit("close", 7, null);
      await running;
      process.exitCode = originalCode;
      exit.mockRestore();
    }
  });
});
