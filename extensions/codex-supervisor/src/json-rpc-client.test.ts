// Codex Supervisor tests cover JSON-RPC transport behavior.
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
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

function waitForChildClose(proc: ChildProcessWithoutNullStreams) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for stdio child close"));
    }, 5_000);
    timer.unref?.();
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForReadableData(stream: NodeJS.ReadableStream) {
  return new Promise<void>((resolve, reject) => {
    let cleanup = () => {};
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for stdio child output"));
    }, 5_000);
    timer.unref?.();
    cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
    };
    const onData = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once("data", onData);
    stream.once("error", onError);
  });
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

  it("routes real child readable stream failures through connection failure and shutdown", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

    for (const streamName of ["stdout", "stderr"] as const) {
      let proc: ChildProcessWithoutNullStreams | undefined;
      let killSpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        spawnMock.mockImplementationOnce(
          (command: string, args: string[] | undefined, options: SpawnOptions | undefined) => {
            proc = actual.spawn(command, args ?? [], options) as ChildProcessWithoutNullStreams;
            return proc;
          },
        );

        const connectPromise = connectCodexAppServerEndpoint({
          id: "local",
          transport: "stdio-proxy",
          command: process.execPath,
          args: [
            "-e",
            [
              "process.stdin.resume();",
              'process.on("SIGTERM", () => process.exit(143));',
              'process.stderr.write("ready\\n");',
              "setInterval(() => {}, 1000);",
            ].join(""),
          ],
        });

        if (!proc) {
          throw new Error("expected stdio transport to spawn a child process");
        }
        expect(proc.pid).toEqual(expect.any(Number));
        killSpy = vi.spyOn(proc, "kill");
        const closePromise = waitForChildClose(proc);
        await waitForReadableData(proc.stderr);
        const message = `synthetic parent ${streamName} read failure`;

        proc[streamName].destroy(new Error(message));

        await expect(connectPromise).rejects.toThrow(message);
        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith("SIGTERM");
        await expect(closePromise).resolves.toStrictEqual({ code: 143, signal: null });
      } finally {
        killSpy?.mockRestore();
        if (proc && proc.exitCode === null && !proc.killed) {
          proc.kill("SIGKILL");
        }
      }
    }
  });
});
