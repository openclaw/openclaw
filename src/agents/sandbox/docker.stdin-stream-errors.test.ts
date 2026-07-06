// Regression tests for stdin stream errors in docker sandbox execution.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it, vi } from "vitest";

type MockSpawnChild = EventEmitter & {
  stdout?: EventEmitter & { setEncoding?: (enc: string) => void };
  stderr?: EventEmitter & { setEncoding?: (enc: string) => void };
  stdin?: EventEmitter & { end?: (chunk?: unknown) => void };
  kill?: (signal?: string) => void;
};

function createMockSpawnChild() {
  const child = new EventEmitter() as MockSpawnChild;
  const stdout = new EventEmitter() as MockSpawnChild["stdout"];
  stdout!.setEncoding = vi.fn();
  const stderr = new EventEmitter() as MockSpawnChild["stderr"];
  stderr!.setEncoding = vi.fn();
  const stdin = new EventEmitter() as MockSpawnChild["stdin"];
  stdin!.end = vi.fn();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = vi.fn();
  return { child, stdout, stderr, stdin };
}

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const spawnLocal = vi.fn(
    (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
      const { child } = createMockSpawnChild();
      return child as unknown as ChildProcess;
    },
  );
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawnLocal as unknown as typeof import("node:child_process").spawn,
    },
  );
});

const spawnMock = vi.mocked(spawn);

let execDockerRaw: typeof import("./docker.js").execDockerRaw;

describe("docker sandbox stdin stream errors", () => {
  beforeAll(async () => {
    ({ execDockerRaw } = await import("./docker.js"));
  });

  it("rejects and terminates the child when stdin emits an error", async () => {
    let capturedChild: MockSpawnChild | undefined;
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stdin, stdout, stderr } = createMockSpawnChild();
        capturedChild = child;
        process.nextTick(() => {
          stdin?.emit("error", new Error("stdin write failed"));
        });
        process.nextTick(() => {
          stdout?.emit("close");
          stderr?.emit("close");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    );

    await expect(execDockerRaw(["version"], { input: "test" })).rejects.toThrow(
      "stdin write failed",
    );
    expect(capturedChild?.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
