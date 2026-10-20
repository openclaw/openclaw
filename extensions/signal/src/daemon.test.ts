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

// mock-isolation: Keep process owners and worker runtimes out of this daemon fixture.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ spawnOomScoreAdjusted: spawnMock }));

function createMockChild() {
  return Object.assign(new EventEmitter(), {
    pid: 1234,
    killed: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

let child: ReturnType<typeof createMockChild>;

function startDaemon(overrides: Partial<Parameters<typeof spawnSignalDaemon>[0]> = {}) {
  return spawnSignalDaemon({
    cliPath: "signal-cli",
    httpHost: "127.0.0.1",
    httpPort: 8080,
    ...overrides,
  });
}

beforeEach(() => {
  child = createMockChild();
  spawnMock.mockReset().mockReturnValue(child);
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
    startDaemon({ socketPath: "/private/signal/rpc" });
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
        assertSignalDaemonEndpointAvailable({ httpHost: "127.0.0.1", httpPort: address.port }),
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
    const bindError = Object.assign(new Error("bind EACCES 127.0.0.1:443"), { code: "EACCES" });
    ensurePortAvailableMock.mockRejectedValueOnce(bindError);
    await expect(
      assertSignalDaemonEndpointAvailable({ httpHost: "127.0.0.1", httpPort: 443 }),
    ).resolves.toBeUndefined();
  });

  it("expands home-relative configPath before passing it to signal-cli", () => {
    startDaemon({ configPath: "~/.openclaw/signal-cli" });
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
    const log = vi.fn();
    const error = vi.fn();
    startDaemon({ runtime: { log, error, exit: vi.fn() } });
    const ended = once(child.stderr, "end");
    child.stderr.write(Buffer.from("ER"));
    child.stderr.write(
      Buffer.from(
        "ROR DaemonCommand - startup failed\r\nSEVERE Manager - database exception\nWARN Manager - retrying\nreceive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed\npartial",
      ),
    );
    child.stderr.write(" warning\n");
    const utf8Line = Buffer.from("INFO Manager - café ready");
    const splitCodePointAt = utf8Line.indexOf(0xc3) + 1;
    child.stderr.write(utf8Line.subarray(0, splitCodePointAt));
    child.stderr.end(utf8Line.subarray(splitCodePointAt));
    await ended;
    expect(error.mock.calls).toEqual([
      ["signal-cli: ERROR DaemonCommand - startup failed"],
      ["signal-cli: SEVERE Manager - database exception"],
    ]);
    expect(log.mock.calls).toEqual([
      ["signal-cli: WARN Manager - retrying"],
      [
        "signal-cli: receive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed",
      ],
      ["signal-cli: partial warning"],
      ["signal-cli: INFO Manager - café ready"],
    ]);
  });

  it("falls back to SIGKILL when the daemon does not exit after SIGTERM", async () => {
    vi.useFakeTimers();
    const handle = startDaemon();
    const stopPromise = handle.stop();
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    await vi.runOnlyPendingTimersAsync();
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.emit("exit", null, "SIGKILL");
    await stopPromise;
  });

  it("reuses the in-flight stop promise across repeated calls", async () => {
    const handle = startDaemon();
    const firstStop = handle.stop();
    const secondStop = handle.stop();
    expect(firstStop).toBe(secondStop);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("exit", 0, null);
    await Promise.all([firstStop, secondStop]);
  });

  it("does not treat a post-spawn signaling error as process exit", async () => {
    const handle = startDaemon();
    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });
    child.emit("error", new Error("kill EPERM"));
    await Promise.resolve();
    expect(resolved).toBe(false);
    child.emit("exit", 0, null);
    await stopPromise;
    expect(resolved).toBe(true);
  });
});
