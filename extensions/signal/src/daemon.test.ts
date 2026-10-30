// Signal tests cover daemon plugin behavior.
import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSignalDaemonEndpointAvailable, spawnSignalDaemon } from "./daemon.js";

const spawnMock = vi.hoisted(() => vi.fn());
const ensurePortAvailableMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  ensurePortAvailableMock.mockImplementation(actual.ensurePortAvailable);
  return {
    ...actual,
    ensurePortAvailable: (...args: unknown[]) => ensurePortAvailableMock(...args),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 1234;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

let child: ReturnType<typeof createMockChild>;

beforeEach(() => {
  child = createMockChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
  ensurePortAvailableMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  child.stdout.end();
  child.stderr.end();
  child.removeAllListeners();
});

describe("spawnSignalDaemon", () => {
  it("starts the opt-in socket daemon without exposing an HTTP listener", () => {
    spawnSignalDaemon({
      cliPath: "signal-cli",
      socketPath: "/private/signal/rpc",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--socket");
    expect(args).toContain("/private/signal/rpc");
    expect(args).not.toContain("--http");
    expect(args).not.toContain("--tcp");
    expect(args.slice(args.indexOf("--receive-mode"), args.indexOf("--receive-mode") + 2)).toEqual([
      "--receive-mode",
      "manual",
    ]);
  });
  it("rejects an occupied managed endpoint with actionable port guidance", async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener address");
    }

    try {
      await expect(
        assertSignalDaemonEndpointAvailable({
          httpHost: "127.0.0.1",
          httpPort: address.port,
        }),
      ).rejects.toThrow(
        `Signal managed native endpoint 127.0.0.1:${address.port} is unavailable: Port ${address.port} is already in use. Stop the conflicting service, configure this Signal account with a different transport.httpPort, or use external-native for an intentionally operator-managed daemon.`,
      );
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
    // The released port is unowned; let the kernel choose this free probe.
    await expect(
      assertSignalDaemonEndpointAvailable({ httpHost: "127.0.0.1", httpPort: 0 }),
    ).resolves.toBeUndefined();
  });

  it("defers non-collision bind failures to the operator-selected daemon", async () => {
    const bindError = Object.assign(new Error("bind EACCES 127.0.0.1:443"), {
      code: "EACCES",
    });
    ensurePortAvailableMock.mockRejectedValueOnce(bindError);

    await expect(
      assertSignalDaemonEndpointAvailable({
        httpHost: "127.0.0.1",
        httpPort: 443,
      }),
    ).resolves.toBeUndefined();
  });

  it("expands home-relative configPath before passing it to signal-cli", () => {
    spawnSignalDaemon({
      cliPath: "signal-cli",
      configPath: "~/.openclaw/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "signal-cli",
      [
        "--config",
        path.join(os.homedir(), ".openclaw/signal-cli"),
        "daemon",
        "--http",
        "127.0.0.1:8080",
        "--no-receive-stdout",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("classifies complete UTF-8 output lines through the spawned process", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      runtime: {
        log: (...args) => logs.push(args.map(String).join(" ")),
        error: (...args) => errors.push(args.map(String).join(" ")),
        exit: vi.fn(),
      },
    });

    const ended = once(child.stderr, "end");
    child.stderr.write(Buffer.from("ER"));
    child.stderr.write(
      Buffer.from(
        "ROR DaemonCommand - startup failed\r\nWARN Manager - retrying\nreceive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed\npartial",
      ),
    );
    child.stderr.write(" warning\n");
    const utf8Line = Buffer.from("INFO Manager - café ready");
    const splitCodePointAt = utf8Line.indexOf(0xc3) + 1;
    child.stderr.write(utf8Line.subarray(0, splitCodePointAt));
    child.stderr.end(utf8Line.subarray(splitCodePointAt));
    await ended;

    expect(errors).toEqual(["signal-cli: ERROR DaemonCommand - startup failed"]);
    expect(logs).toEqual([
      "signal-cli: WARN Manager - retrying",
      "signal-cli: receive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed",
      "signal-cli: partial warning",
      "signal-cli: INFO Manager - café ready",
    ]);
  });

  it.each(["SEVERE Manager - database exception", "Failed to initialize HTTP Server - oops"])(
    "surfaces untagged failure output: %s",
    async (line) => {
      const error = vi.fn();
      spawnSignalDaemon({
        cliPath: "signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
        runtime: { log: vi.fn(), error, exit: vi.fn() },
      });

      const ended = once(child.stderr, "end");
      child.stderr.end(`${line}\n`);
      await ended;

      expect(error).toHaveBeenCalledWith(`signal-cli: ${line}`);
    },
  );

  it("waits for exit after SIGTERM before resolving stop", async () => {
    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(resolved).toBe(false);

    child.emit("exit", 0, null);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    await stopPromise;
    expect(resolved).toBe(true);
  });

  it("falls back to SIGKILL when the daemon does not exit after SIGTERM", async () => {
    vi.useFakeTimers();
    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    const stopPromise = handle.stop();
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.runOnlyPendingTimersAsync();
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    child.emit("exit", null, "SIGKILL");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, "SIGKILL");
    await stopPromise;
  });

  it("reuses the in-flight stop promise across repeated calls", async () => {
    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    const firstStop = handle.stop();
    const secondStop = handle.stop();

    expect(firstStop).toBe(secondStop);
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.emit("exit", 0, null);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    await Promise.all([firstStop, secondStop]);
  });

  it("does not treat a post-spawn signaling error as process exit", async () => {
    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });

    child.emit("error", new Error("kill EPERM"));
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.emit("exit", 0, null);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    await stopPromise;
    expect(resolved).toBe(true);
  });

  it("waits for process exit and stdio EOF before resolving stop", async () => {
    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(resolved).toBe(false);

    // Even after the old 1.5s SIGKILL fallback timer, stop() must not resolve
    // until both the process exit and stdio EOF have been observed.
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.stdout.end();
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.stderr.end();
    child.emit("close", 0, null);
    await stopPromise;
    expect(resolved).toBe(true);
  });

  it("uses a configurable SIGTERM-to-SIGKILL grace period", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      stopTimeoutMs: 10_000,
    });

    const stopPromise = handle.stop();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_500);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("exit", null, "SIGKILL");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, "SIGKILL");
    await stopPromise;
  });

  it("force-resolves stop when stdio never ends after SIGKILL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const errors: string[] = [];
    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      stopTimeoutMs: 1_000,
      runtime: { log: vi.fn(), error: (message: string) => errors.push(message), exit: vi.fn() },
    });

    const stopPromise = handle.stop();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    // Process exits, but a grandchild holds the stdio fds open.
    child.emit("exit", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(500);
    let resolved = false;
    void stopPromise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await stopPromise;
    expect(resolved).toBe(true);
    expect(
      errors.some((message) =>
        /force-resolving after 2000ms.*pending: (stdout|stderr|exit)/.test(message),
      ),
    ).toBe(true);
  });
});
