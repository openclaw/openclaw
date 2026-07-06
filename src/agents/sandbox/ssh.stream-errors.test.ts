// SSH sandbox stream-error handling tests
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return { ...actual, spawn: spawnMock };
});

describe("ssh sandbox stream error handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("runSshSandboxCommand registers error listeners on stdout and stderr", async () => {
    const child = createMockChildProcess();
    const stdoutOn = vi.spyOn(child.stdout, "on");
    const stderrOn = vi.spyOn(child.stderr, "on");

    spawnMock.mockImplementationOnce(
      (_cmd: string, _args: readonly string[], _opts: SpawnOptions): ChildProcess => {
        process.nextTick(() => child.emit("close", 1));
        return child as unknown as ChildProcess;
      },
    );

    const { runSshSandboxCommand } = await import("./ssh.js");

    try {
      await runSshSandboxCommand({
        command: "echo test",
        target: { host: "localhost", username: "test", connectTimeoutMs: 100 },
        allowFailure: true,
      });
    } catch {
      // Expected — we mocked a failing close
    }

    expect(stdoutOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(stderrOn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("uploadDirectoryToSshTarget registers error listeners on tar and ssh streams", async () => {
    const tarChild = createMockChildProcess();
    const sshChild = createMockChildProcess();
    const tarStderrOn = vi.spyOn(tarChild.stderr, "on");
    const sshStdoutOn = vi.spyOn(sshChild.stdout, "on");
    const sshStderrOn = vi.spyOn(sshChild.stderr, "on");

    spawnMock
      .mockImplementationOnce(
        (_cmd: string, _args: readonly string[], _opts: SpawnOptions): ChildProcess => {
          process.nextTick(() => tarChild.emit("close", 0));
          return tarChild as unknown as ChildProcess;
        },
      )
      .mockImplementationOnce(
        (_cmd: string, _args: readonly string[], _opts: SpawnOptions): ChildProcess => {
          process.nextTick(() => sshChild.emit("close", 0));
          return sshChild as unknown as ChildProcess;
        },
      );

    const { uploadDirectoryToSshTarget } = await import("./ssh.js");

    try {
      await uploadDirectoryToSshTarget({
        localPath: "/tmp/test",
        remotePath: "/tmp/test",
        target: { host: "localhost", username: "test", connectTimeoutMs: 100 },
      });
    } catch {
      // Expected
    }

    expect(tarStderrOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(sshStdoutOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(sshStderrOn).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
