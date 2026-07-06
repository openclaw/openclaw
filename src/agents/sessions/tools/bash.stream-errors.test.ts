// Bash stream error tests verify that stdout/stderr errors reject the exec promise
// instead of crashing the agent runtime.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createLocalBashOperations } from "./bash.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../shell-utils.js", () => ({
  getBashShellConfig: () => ({ shell: "/bin/sh", args: ["-c"] }),
  getShellEnv: () => ({}),
  killProcessTree: vi.fn(),
}));

const { spawn } = await import("node:child_process");
const { killProcessTree } = await import("../../shell-utils.js");

function createMockChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return child as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
}

describe("local bash operations stream errors", () => {
  it("rejects when stdout emits an error", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const operations = createLocalBashOperations();
    const resultPromise = operations.exec("echo hello", process.cwd(), {
      onData: () => {},
    });

    child.stdout.emit("error", new Error("stdout EPIPE"));

    await expect(resultPromise).rejects.toThrow("stdout EPIPE");
    expect(killProcessTree).toHaveBeenCalledWith(12345);
  });

  it("rejects when stderr emits an error", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const operations = createLocalBashOperations();
    const resultPromise = operations.exec("echo hello", process.cwd(), {
      onData: () => {},
    });

    child.stderr.emit("error", new Error("stderr EPIPE"));

    await expect(resultPromise).rejects.toThrow("stderr EPIPE");
    expect(killProcessTree).toHaveBeenCalledWith(12345);
  });
});
