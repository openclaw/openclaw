// Stream-error handling tests for codex-supervisor StdioCodexJsonRpcConnection.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { connectCodexAppServerEndpoint } from "./json-rpc-client.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import(
    "openclaw/plugin-sdk/test-node-mocks"
  );
  return mockNodeBuiltinModule(
    () =>
      vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: spawnMock },
  );
});

describe("StdioCodexJsonRpcConnection stream error handling", () => {
  it("registers error listeners on stdout and stderr", async () => {
    const stdout = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    const stderr = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn((_data: string, cb?: (err?: Error) => void) => cb?.()),
    });

    const stdoutOn = vi.spyOn(stdout, "on");
    const stderrOn = vi.spyOn(stderr, "on");

    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      stdout,
      stderr,
      stdin,
    }) as ChildProcess;

    spawnMock.mockReturnValue(child);

    // Emit close after the constructor sets up listeners, failing initialization fast.
    queueMicrotask(() => child.emit("close"));

    await expect(
      connectCodexAppServerEndpoint({
        id: "test",
        transport: "stdio-proxy",
      }),
    ).rejects.toThrow("Codex app-server stdio transport closed");

    expect(stdoutOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(stderrOn).toHaveBeenCalledWith("error", expect.any(Function));

    const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(options?.stdio).toBe("pipe");
  });
});
