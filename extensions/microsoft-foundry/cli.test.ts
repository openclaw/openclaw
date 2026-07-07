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
      await expect(loginPromise).rejects.toThrow(
        `az login ${streamName} stream failed: EPIPE`,
      );
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
});
