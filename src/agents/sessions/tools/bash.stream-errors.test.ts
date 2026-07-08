import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalBashOperations } from "./bash.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../shell-utils.js", () => ({
  getBashShellConfig: vi.fn(() => ({ shell: "/bin/bash", args: ["-c"] })),
  getShellEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
  killProcessTree: vi.fn(),
}));

vi.mock("../../utils/child-process.js", () => ({
  waitForChildProcess: vi.fn(() => Promise.resolve(0)),
}));

afterEach(() => {
  vi.clearAllMocks();
});

type MockChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function createChild(): MockChild {
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as MockChild;
  Object.defineProperty(child, "killed", { get: () => killed });
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });
  return child;
}

function mockSpawn(child: MockChild) {
  vi.mocked(spawn).mockReturnValue(child);
}

describe("bash stream errors", () => {
  it.each(["stdout", "stderr"] as const)(
    "does not throw when %s stream errors after data listener is attached",
    async (stream) => {
      const child = createChild();
      mockSpawn(child);

      const ops = createLocalBashOperations();
      const execPromise = ops.exec("echo ok", "/tmp", {
        onData: () => {},
        env: {},
      });

      // Let the spawn settle so data/error listeners are registered.
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

      // Emitting a stream error should not crash the process — the error
      // handler we added suppresses it.  If no handler were registered,
      // Node.js would throw an unhandled 'error' event.
      expect(() => {
        child[stream].emit("error", new Error(`${stream} EPIPE`));
      }).not.toThrow();

      // The execution should eventually settle via waitForChildProcess.
      await expect(execPromise).resolves.toEqual({ exitCode: 0 });
    },
  );

  it("survives stdout error then stderr error without crashing", async () => {
    const child = createChild();
    mockSpawn(child);

    const chunks: Buffer[] = [];
    const ops = createLocalBashOperations();
    const execPromise = ops.exec("echo ok", "/tmp", {
      onData: (chunk) => chunks.push(chunk),
      env: {},
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    // Both streams error — neither should throw.
    expect(() => {
      child.stdout.emit("error", new Error("stdout broken"));
      child.stderr.emit("error", new Error("stderr broken"));
    }).not.toThrow();

    await expect(execPromise).resolves.toEqual({ exitCode: 0 });
  });

  it("still receives data on the surviving stream after the peer errors", async () => {
    const child = createChild();
    mockSpawn(child);

    const chunks: Buffer[] = [];
    const ops = createLocalBashOperations();
    const execPromise = ops.exec("echo ok", "/tmp", {
      onData: (chunk) => chunks.push(chunk),
      env: {},
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    // stderr errors first, stdout keeps delivering.
    child.stderr.emit("error", new Error("stderr broken"));
    child.stdout.emit("data", Buffer.from("still-alive\n"));

    await expect(execPromise).resolves.toEqual({ exitCode: 0 });
    expect(chunks.some((c) => c.toString().includes("still-alive"))).toBe(true);
  });

  it("completes normally when streams never error", async () => {
    const child = createChild();
    mockSpawn(child);

    const chunks: Buffer[] = [];
    const ops = createLocalBashOperations();
    const execPromise = ops.exec("echo ok", "/tmp", {
      onData: (chunk) => chunks.push(chunk),
      env: {},
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    // Normal data flow — no errors.
    child.stdout.emit("data", Buffer.from("hello\n"));
    child.stderr.emit("data", Buffer.from(""));

    // Simulate waitForChildProcess resolving.
    await expect(execPromise).resolves.toEqual({ exitCode: 0 });
    expect(chunks.length).toBeGreaterThan(0);
  });
});
