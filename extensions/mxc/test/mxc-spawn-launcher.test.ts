import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { decodePayload, forwardSignals, launchSandbox, signalExitCode } = createRequire(
  import.meta.url,
)("../src/mxc-spawn-launcher.mjs") as {
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
    bridges?: { child?: (spawned: unknown) => void; pty?: (spawned: unknown) => void },
  ) => Promise<void>;
  signalExitCode: (signal: number | string | undefined) => number;
};

describe("mxc-spawn-launcher", () => {
  it("decodes a JSON --payload-file and removes it before spawning", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mxc-launcher-test-"));
    const payloadFile = path.join(dir, "payload.json");
    const body = { config: { process: { env: ["SECRET=value"] } }, options: {} };
    try {
      writeFileSync(payloadFile, JSON.stringify(body), "utf-8");

      expect(decodePayload(["--payload-file", payloadFile])).toEqual(body);
      expect([payloadFile, dir].map(existsSync)).toEqual([false, false]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("throws when --payload is missing", () => {
    expect(() => decodePayload([])).toThrow(/Missing --payload-file/);
  });

  it("maps PTY signal exits to process exit codes", () => {
    expect([15, "SIGTERM", "SIGINT", "SIGUNKNOWN", undefined].map(signalExitCode)).toEqual([
      143, 143, 130, 1, 1,
    ]);
  });

  it("resolves a promised PTY before selecting its bridge", async () => {
    const pty = { onData: vi.fn() };
    const spawnResult = Promise.resolve(pty);
    const ptyBridge = vi.fn();
    const childBridge = vi.fn();

    await launchSandbox(() => spawnResult, { process: {} }, undefined, {
      pty: ptyBridge,
      child: childBridge,
    });

    expect(ptyBridge.mock.calls).toEqual([[pty]]);
    expect(childBridge).not.toHaveBeenCalled();
  });

  it("forwards process termination signals to spawned sandbox children", () => {
    const processOn = vi.spyOn(process, "on").mockReturnValue(process);
    const spawned = { kill: vi.fn() };
    const clearTimeoutMock = vi.fn();
    const timer = { unref: vi.fn() };
    const setTimeoutMock = vi.fn((_callback: () => void, _ms: number) => timer);
    try {
      const signals = forwardSignals(spawned, {
        exitGraceMs: 25,
        setTimeout: setTimeoutMock,
        clearTimeout: clearTimeoutMock,
      });

      processOn.mock.calls.find(([event]) => event === "SIGTERM")?.[1]();
      processOn.mock.calls.find(([event]) => event === "SIGINT")?.[1]();

      expect(spawned.kill.mock.calls).toEqual([["SIGTERM"], ["SIGINT"]]);
      expect(setTimeoutMock.mock.calls).toEqual([[expect.any(Function), 25]]);
      expect(timer.unref).toHaveBeenCalledTimes(1);

      setTimeoutMock.mock.calls[0]?.[0]();

      expect(spawned.kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(signals.exitCode()).toBe(143);
      signals.dispose();
      expect(clearTimeoutMock).toHaveBeenCalledWith(timer);
    } finally {
      processOn.mockRestore();
    }
  });

  it("waits for child stdio closure and releases launcher input and signal listeners", async () => {
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
