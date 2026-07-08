// Microsoft Foundry tests cover Azure CLI process behavior.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { azLoginDeviceCodeWithOptions } from "./cli.js";

function createAzLoginProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => true);
  return proc;
}

describe("azLoginDeviceCodeWithOptions", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("rejects cleanly when az login stdio streams error", async () => {
    for (const streamName of ["stdout", "stderr"] as const) {
      const proc = createAzLoginProcess();
      spawnMock.mockReturnValueOnce(proc);

      const loginPromise = azLoginDeviceCodeWithOptions({
        tenantId: "tenant-1",
        allowNoSubscriptions: true,
      });

      expect(() => proc[streamName].emit("error", new Error("EPIPE"))).not.toThrow();
      expect(() => proc.stderr.emit("error", new Error("duplicate EPIPE"))).not.toThrow();
      expect(() => proc.emit("error", new Error("late child error"))).not.toThrow();
      expect(proc.kill).toHaveBeenCalledTimes(1);
      proc.emit("close", 1);
      await expect(loginPromise).rejects.toThrow(`az login ${streamName} stream failed: EPIPE`);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    }

    expect(spawnMock).toHaveBeenCalledWith(
      "az",
      ["login", "--use-device-code", "--tenant", "tenant-1", "--allow-no-subscriptions"],
      {
        stdio: ["inherit", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );
  });

  it("rejects after child exit when a stream-error close event never arrives", async () => {
    vi.useFakeTimers();
    try {
      const proc = createAzLoginProcess();
      spawnMock.mockReturnValueOnce(proc);

      const loginPromise = azLoginDeviceCodeWithOptions({
        tenantId: "tenant-1",
        allowNoSubscriptions: true,
      });
      let rejected = false;
      loginPromise.catch(() => {
        rejected = true;
      });

      expect(() => proc.stdout.emit("error", new Error("EPIPE"))).not.toThrow();
      proc.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(999);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(loginPromise).rejects.toThrow("az login stdout stream failed: EPIPE");
      expect(proc.kill).toHaveBeenCalledTimes(1);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects after SIGKILL grace when a stream-error child never exits or closes", async () => {
    vi.useFakeTimers();
    try {
      const proc = createAzLoginProcess();
      spawnMock.mockReturnValueOnce(proc);

      const loginPromise = azLoginDeviceCodeWithOptions({
        tenantId: "tenant-1",
        allowNoSubscriptions: true,
      });
      let rejected = false;
      loginPromise.catch(() => {
        rejected = true;
      });

      expect(() => proc.stdout.emit("error", new Error("EPIPE"))).not.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rejected).toBe(false);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(loginPromise).rejects.toThrow("az login stdout stream failed: EPIPE");
      expect(proc.kill).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
