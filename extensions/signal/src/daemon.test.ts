// Signal tests cover daemon plugin behavior.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testApi } from "./daemon.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

function createFakeDaemonChild() {
  const child = new EventEmitter() as EventEmitter & ChildProcessWithoutNullStreams;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = false;
  const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>((signal) => {
    if (signal) {
      killed = true;
    }
    return true;
  });

  Object.defineProperty(child, "killed", {
    get: () => killed,
    configurable: true,
  });
  Object.defineProperty(child, "pid", {
    value: 4321,
    configurable: true,
  });

  child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
  child.stdin = null as unknown as ChildProcessWithoutNullStreams["stdin"];
  child.kill = kill as ChildProcessWithoutNullStreams["kill"];

  return { child, kill };
}

describe("signal daemon args", () => {
  it("expands home-relative configPath before passing it to signal-cli", () => {
    expect(
      testApi.buildDaemonArgs({
        cliPath: "signal-cli",
        configPath: "~/.openclaw/signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toEqual([
      "--config",
      path.join(os.homedir(), ".openclaw/signal-cli"),
      "daemon",
      "--http",
      "127.0.0.1:8080",
      "--no-receive-stdout",
    ]);
  });
});

describe("signal daemon log classification", () => {
  it("keeps routine signal-cli warnings out of error state", () => {
    expect(
      testApi.classifySignalCliLogLine(
        "WARN  ManagerImpl - No profile name set. When sending a message it's recommended to set a profile name.",
      ),
    ).toBe("log");
  });

  it("keeps recoverable prekey decrypt receive failures out of error state", () => {
    expect(
      testApi.classifySignalCliLogLine(
        "receive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed",
      ),
    ).toBe("log");
  });

  it("still surfaces signal-cli failures as errors", () => {
    expect(testApi.classifySignalCliLogLine("ERROR DaemonCommand - startup failed")).toBe("error");
    expect(testApi.classifySignalCliLogLine("SEVERE Manager - database exception")).toBe("error");
  });
});

describe("spawnSignalDaemon stop", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for exit after SIGTERM before resolving stop", async () => {
    const fake = createFakeDaemonChild();
    spawnMock.mockReturnValue(fake.child);
    const { spawnSignalDaemon } = await import("./daemon.js");

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

    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
    expect(resolved).toBe(false);

    fake.child.emit("exit", 0, null);
    fake.child.emit("close", 0, null);
    await stopPromise;

    expect(resolved).toBe(true);
  });

  it("falls back to SIGKILL if the daemon does not exit in time", async () => {
    vi.useFakeTimers();
    const fake = createFakeDaemonChild();
    spawnMock.mockReturnValue(fake.child);
    const { SIGNAL_DAEMON_STOP_KILL_TIMEOUT_MS, spawnSignalDaemon } = await import("./daemon.js");

    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    const stopPromise = handle.stop();
    await vi.advanceTimersByTimeAsync(SIGNAL_DAEMON_STOP_KILL_TIMEOUT_MS + 1);

    expect(fake.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(fake.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    fake.child.emit("exit", null, "SIGKILL");
    fake.child.emit("close", null, "SIGKILL");
    await stopPromise;
  });

  it("reuses the same in-flight stop promise across repeated stop calls", async () => {
    const fake = createFakeDaemonChild();
    spawnMock.mockReturnValue(fake.child);
    const { spawnSignalDaemon } = await import("./daemon.js");

    const handle = spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    const firstStop = handle.stop();
    const secondStop = handle.stop();

    expect(firstStop).toBe(secondStop);
    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");

    fake.child.emit("exit", 0, null);
    fake.child.emit("close", 0, null);
    await firstStop;
    await secondStop;
  });
});
