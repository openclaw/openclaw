// SSH sandbox output buffer bound tests: verify that runSshSandboxCommand
// passes the SSH-specific 16 MiB maxBuffer to spawnCommand and surfaces
// maxBuffer failures through the generic command-error path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SshSandboxSession } from "./ssh.js";

const { spawnCommandMock } = vi.hoisted(() => ({
  spawnCommandMock: vi.fn(),
}));

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnCommandMock,
}));

const SSH_SANDBOX_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const fakeSession: SshSandboxSession = {
  command: "ssh",
  configPath: "/tmp/openclaw-test-ssh-config",
  host: "openclaw-sandbox",
};

let runSshSandboxCommand: typeof import("./ssh.js").runSshSandboxCommand;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  spawnCommandMock.mockResolvedValue({
    failed: false,
    isCanceled: false,
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  ({ runSshSandboxCommand } = await import("./ssh.js"));
});

describe("runSshSandboxCommand output bound", () => {
  it("passes the SSH-specific 16 MiB maxBuffer to spawnCommand", async () => {
    await runSshSandboxCommand({
      session: fakeSession,
      remoteCommand: "echo ok",
    });

    const options = spawnCommandMock.mock.calls[0]?.[1] as { maxBuffer?: number } | undefined;
    expect(options?.maxBuffer).toBe(SSH_SANDBOX_MAX_OUTPUT_BYTES);
  });

  it("returns buffered stdout/stderr on success", async () => {
    spawnCommandMock.mockResolvedValueOnce({
      failed: false,
      isCanceled: false,
      exitCode: 0,
      stdout: Buffer.from("hello world"),
      stderr: Buffer.from("warn"),
    });

    const result = await runSshSandboxCommand({
      session: fakeSession,
      remoteCommand: "echo ok",
    });

    expect(result.stdout.toString("utf8")).toBe("hello world");
    expect(result.stderr.toString("utf8")).toBe("warn");
    expect(result.code).toBe(0);
  });

  it("surfaces a maxBuffer failure as a command error", async () => {
    spawnCommandMock.mockResolvedValueOnce({
      failed: true,
      isMaxBuffer: true,
      isCanceled: false,
      exitCode: undefined,
      stdout: Buffer.from("partial"),
      stderr: Buffer.alloc(0),
    });

    await expect(
      runSshSandboxCommand({
        session: fakeSession,
        remoteCommand: "cat /dev/urandom",
      }),
    ).rejects.toThrow("SSH command execution failed");
  });

  it("preserves partial output on the error when maxBuffer is hit", async () => {
    spawnCommandMock.mockResolvedValueOnce({
      failed: true,
      isMaxBuffer: true,
      isCanceled: false,
      exitCode: undefined,
      stdout: Buffer.from("prefix-"),
      stderr: Buffer.from("errprefix-"),
    });

    const error = (await runSshSandboxCommand({
      session: fakeSession,
      remoteCommand: "cat /dev/urandom",
    }).catch((e: unknown) => e)) as Error & { stdout?: Buffer; stderr?: Buffer };

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("SSH command execution failed");
    expect(error.stdout?.toString("utf8")).toBe("prefix-");
    expect(error.stderr?.toString("utf8")).toBe("errprefix-");
  });

  it("does not treat maxBuffer as a plain exit failure", async () => {
    // isPlainCommandExitFailure returns false when isMaxBuffer is true,
    // so the error bypasses the exit-code path and goes through toErrorObject.
    spawnCommandMock.mockResolvedValueOnce({
      failed: true,
      isMaxBuffer: true,
      isCanceled: false,
      exitCode: 1,
      signal: undefined,
      cause: undefined,
      timedOut: false,
      isTerminated: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });

    await expect(
      runSshSandboxCommand({
        session: fakeSession,
        remoteCommand: "cat /dev/urandom",
      }),
    ).rejects.toThrow("SSH command execution failed");
  });
});
