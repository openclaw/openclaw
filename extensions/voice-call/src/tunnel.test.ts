import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { isNgrokAvailable, startNgrokTunnel } from "./tunnel.js";

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = false;
  const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => {
    killed = true;
    return true;
  });

  Object.defineProperty(child, "stdout", {
    value: stdout,
    configurable: true,
  });
  Object.defineProperty(child, "stderr", {
    value: stderr,
    configurable: true,
  });
  Object.defineProperty(child, "stdin", {
    value: null,
    configurable: true,
  });
  Object.defineProperty(child, "kill", {
    value: kill,
    configurable: true,
  });
  Object.defineProperty(child, "killed", {
    get: () => killed,
    configurable: true,
  });

  return { child, stdout, stderr, kill };
}

describe("voice-call tunnel ngrok timeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns false when ngrok version probe hangs", async () => {
    vi.useFakeTimers();
    const fake = createFakeChild();
    spawnMock.mockReturnValue(fake.child);

    const availabilityPromise = isNgrokAvailable();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(availabilityPromise).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledWith("ngrok", ["version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("times out ngrok auth-token setup before tunnel startup", async () => {
    vi.useFakeTimers();
    const fake = createFakeChild();
    spawnMock.mockReturnValue(fake.child);

    const tunnelPromise = expect(
      startNgrokTunnel({
        port: 3334,
        path: "/voice/webhook",
        authToken: "token-123",
      }),
    ).rejects.toThrow("ngrok command timed out after 30000ms");

    await vi.advanceTimersByTimeAsync(30_000);

    await tunnelPromise;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("ngrok", ["config", "add-authtoken", "token-123"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
