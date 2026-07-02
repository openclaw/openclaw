import type { ChildProcess } from "node:child_process";
// SSH sandbox output buffer bound tests: verify that runSshSandboxCommand
// caps accumulated stdout+stderr and kills the child process when the
// combined output exceeds 16 MiB.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSshSandboxCommand, type SshSandboxSession } from "./ssh.js";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mockSpawn };
});

const fakeSession: SshSandboxSession = {
  command: "ssh",
  configPath: "/tmp/openclaw-test-ssh-config",
  host: "openclaw-sandbox",
};

function fakeSpawn(): {
  stdout: EventEmitter;
  stderr: EventEmitter;
  child: EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stdin: { end: ReturnType<typeof vi.fn> };
  };
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kill = vi.fn();
  const end = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    kill,
    stdin: { end },
    stdout,
    stderr,
  });
  return { stdout, stderr, child };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSshSandboxCommand output bound", () => {
  it("buffers stdout/stderr under the output cap", async () => {
    const { stdout, stderr, child } = fakeSpawn();
    mockSpawn.mockReturnValue(child as unknown as ChildProcess);

    const promise = runSshSandboxCommand({
      session: fakeSession,
      remoteCommand: "echo ok",
    });

    stdout.emit("data", Buffer.from("hello "));
    stderr.emit("data", Buffer.from("warn "));
    stdout.emit("data", Buffer.from("world"));
    child.emit("close", 0);

    const result = await promise;
    expect(result.stdout.toString("utf8")).toBe("hello world");
    expect(result.stderr.toString("utf8")).toBe("warn ");
    expect(result.code).toBe(0);
  });

  it("caps stdout+stderr at 16 MiB and kills the process", async () => {
    const { stdout, child } = fakeSpawn();
    mockSpawn.mockReturnValue(child as unknown as ChildProcess);

    const promise = runSshSandboxCommand({
      session: fakeSession,
      remoteCommand: "cat /dev/urandom",
    });

    const hugeChunk = Buffer.alloc(17 * 1024 * 1024, 0x41);
    stdout.emit("data", hugeChunk);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null);

    await expect(promise).rejects.toThrow(/exceeded \d+ byte limit/);
  });

  it("caps combined stdout+stderr across many small chunks", async () => {
    const { stdout, stderr, child } = fakeSpawn();
    mockSpawn.mockReturnValue(child as unknown as ChildProcess);

    const promise = runSshSandboxCommand({
      session: fakeSession,
      remoteCommand: "yes",
    });

    const chunk = Buffer.alloc(1024 * 1024, 0x42);
    for (let i = 0; i < 10; i++) {
      stdout.emit("data", chunk);
      stderr.emit("data", chunk.subarray(0, 1024));
    }
    expect(child.kill).not.toHaveBeenCalled();

    for (let i = 0; i < 7; i++) {
      stdout.emit("data", chunk);
      stderr.emit("data", chunk.subarray(0, 1024));
    }

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null);

    await expect(promise).rejects.toThrow(/exceeded \d+ byte limit/);
  });

  it("preserves accumulated output in the error when capped", async () => {
    const { stdout, stderr, child } = fakeSpawn();
    mockSpawn.mockReturnValue(child as unknown as ChildProcess);

    const promise = runSshSandboxCommand({
      session: fakeSession,
      remoteCommand: "cat /dev/urandom",
    });

    stdout.emit("data", Buffer.from("prefix-"));
    stderr.emit("data", Buffer.from("errprefix-"));
    stdout.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x41));

    child.emit("close", null);

    const error = await promise.catch(
      (e: unknown) => e as Error & { stdout?: Buffer; stderr?: Buffer },
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.stdout?.toString("utf8")).toBe("prefix-");
    expect(error.stderr?.toString("utf8")).toBe("errprefix-");
  });

  it("ignores data events after cap is hit", async () => {
    const { stdout, child } = fakeSpawn();
    mockSpawn.mockReturnValue(child as unknown as ChildProcess);

    const promise = runSshSandboxCommand({
      session: fakeSession,
      remoteCommand: "cat /dev/urandom",
    });

    stdout.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x41));
    stdout.emit("data", Buffer.from("after-cap"));

    child.emit("close", null);

    const error = await promise.catch((e: unknown) => e as Error & { stdout?: Buffer });
    expect(error.stdout?.toString("utf8")).not.toContain("after-cap");
  });
});
