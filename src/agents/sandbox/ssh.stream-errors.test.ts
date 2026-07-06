// Regression tests for stdout/stderr stream errors in SSH sandbox commands.
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

let runSshSandboxCommand: typeof import("./ssh.js").runSshSandboxCommand;

function fakeSession() {
  return {
    configPath: "/tmp/ssh-config",
    host: "host",
    user: "user",
    port: 22,
    privateKeyPath: "/tmp/key",
    remoteHost: "remote",
  } as unknown as import("./ssh.js").SshSandboxSession;
}

describe("ssh sandbox stream errors", () => {
  beforeAll(async () => {
    ({ runSshSandboxCommand } = await import("./ssh.js"));
  });

  it("rejects when stdout emits an error", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stdout } = createMockSpawnChild();
        process.nextTick(() => {
          stdout?.emit("error", new Error("stdout read failed"));
        });
        return child as unknown as ChildProcess;
      },
    );

    await expect(
      runSshSandboxCommand({
        session: fakeSession(),
        remoteCommand: "echo hi",
        allowFailure: false,
      }),
    ).rejects.toThrow("stdout read failed");
  });

  it("rejects when stderr emits an error", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          stderr?.emit("error", new Error("stderr read failed"));
        });
        return child as unknown as ChildProcess;
      },
    );

    await expect(
      runSshSandboxCommand({
        session: fakeSession(),
        remoteCommand: "echo hi",
        allowFailure: false,
      }),
    ).rejects.toThrow("stderr read failed");
  });

  it("rejects when stdin emits an error", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stdin } = createMockSpawnChild();
        process.nextTick(() => {
          stdin?.emit("error", new Error("stdin write failed"));
        });
        return child as unknown as ChildProcess;
      },
    );

    await expect(
      runSshSandboxCommand({
        session: fakeSession(),
        remoteCommand: "echo hi",
        allowFailure: false,
      }),
    ).rejects.toThrow("stdin write failed");
  });
});
