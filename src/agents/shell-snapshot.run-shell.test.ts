/** Tests for runShell stream error handling. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { testing } from "./shell-snapshot.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("node:child_process");

describe("runShell", () => {
  it("finishes gracefully when stdout emits an error", async () => {
    const mockSpawn = vi.mocked(spawn);
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter & { setEncoding: (enc: string) => void; destroy: () => void };
    };
    const stdout = new EventEmitter() as EventEmitter & {
      setEncoding: (enc: string) => void;
      destroy: () => void;
    };
    stdout.setEncoding = () => {};
    stdout.destroy = () => {};
    child.pid = 1234;
    child.stdout = stdout;
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const resultPromise = testing.runShell({
      shell: "/bin/bash",
      shellArgs: ["-c"],
      command: "echo hello",
      cwd: "/tmp",
      env: {},
      timeoutMs: 30_000,
    });

    stdout.emit("error", new Error("stdout EPIPE"));

    const result = await resultPromise;
    expect(result.status).toBeNull();
  });
});
