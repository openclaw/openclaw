// Codex Supervisor tests cover JSON-RPC transport behavior.
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

import { connectCodexAppServerEndpoint } from "./json-rpc-client.js";

function createCodexStdioProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => true);
  return proc;
}

describe("connectCodexAppServerEndpoint stdio transport", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("rejects initialization when stdio readable streams error", async () => {
    for (const streamName of ["stdout", "stderr"] as const) {
      const proc = createCodexStdioProcess();
      spawnMock.mockReturnValueOnce(proc);

      const connectPromise = connectCodexAppServerEndpoint({
        id: "local",
        transport: "stdio-proxy",
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
      });

      expect(() => proc[streamName].emit("error", new Error("EPIPE"))).not.toThrow();
      await expect(connectPromise).rejects.toThrow("EPIPE");
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });
});
