// SSH spawn-env tests ensure subprocesses inherit only safe environment values
// while command execution and uploads run through ssh.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureFullEnv } from "../../test-utils/env.js";
import { SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./constants.js";

const { spawnMock, spawnCommandMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnCommandMock: vi.fn(),
}));

const session = {
  command: "ssh",
  configPath: "/tmp/openclaw-test-ssh-config",
  host: "openclaw-sandbox",
};

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
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnCommandMock,
}));

function mockSuccessfulSpawnCalls(times = 1) {
  let chain = spawnMock;
  for (let i = 0; i < times; i += 1) {
    chain = chain.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    );
  }
}

function spawnOptionsAt(index: number): SpawnOptions {
  // Secret filtering happens at the child_process.spawn boundary, so tests read
  // the captured SpawnOptions env directly.
  const options = spawnMock.mock.calls[index]?.[2] as SpawnOptions | undefined;
  if (!options) {
    throw new Error(`expected spawn options for call ${index}`);
  }
  return options;
}

function spawnCommandOptions(): {
  baseEnv: Record<string, string>;
  maxBuffer?: number;
} {
  const options = spawnCommandMock.mock.calls[0]?.[1] as
    | { baseEnv?: Record<string, string>; maxBuffer?: number }
    | undefined;
  if (!options?.baseEnv) {
    throw new Error("expected spawnCommand options");
  }
  return { ...options, baseEnv: options.baseEnv };
}

let runSshSandboxCommand: typeof import("./ssh.js").runSshSandboxCommand;
let prepareSshSandboxExec: typeof import("./ssh.js").prepareSshSandboxExec;
let uploadDirectoryToSshTarget: typeof import("./ssh.js").uploadDirectoryToSshTarget;

beforeAll(async () => {
  vi.resetModules();
  ({ prepareSshSandboxExec, runSshSandboxCommand, uploadDirectoryToSshTarget } =
    await import("./ssh.js"));
});

describe("ssh subprocess env sanitization", () => {
  const ownedDirs = useAutoCleanupTempDirTracker(afterEach);
  let envSnapshot: ReturnType<typeof captureFullEnv>;

  beforeEach(() => {
    envSnapshot = captureFullEnv();
    vi.clearAllMocks();
    spawnCommandMock.mockResolvedValue({
      failed: false,
      isCanceled: false,
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  });

  afterEach(() => envSnapshot.restore());

  it("rejects invalid SSH environment names without exposing their values", async () => {
    const name = "PADDED_NAME ";
    const sentinel = "synthetic-invalid-name-value";
    await expect(
      prepareSshSandboxExec({
        session,
        remoteCommand: "'/bin/sh' '-c' 'true'",
        env: { [name]: sentinel },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("POSIX variable name");
      expect(message).not.toContain(sentinel);
      return true;
    });
    expect(spawnCommandMock).not.toHaveBeenCalled();
  });

  it("rejects NUL-containing SSH environment values before spawning without exposing them", async () => {
    const sentinel = "synthetic-private-value";
    await expect(
      prepareSshSandboxExec({
        session,
        remoteCommand: "'/bin/sh' '-c' 'true'",
        env: { SYNTHETIC_VALUE: `${sentinel}\0suffix` },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("SYNTHETIC_VALUE");
      expect(message).toContain("NUL");
      expect(message).not.toContain(sentinel);
      return true;
    });
    expect(spawnCommandMock).not.toHaveBeenCalled();
  });

  it("preserves explicit TTY terminal values in staged stdin without SSH SetEnv", async () => {
    process.env.OPENAI_API_KEY = "x";
    process.env.LANG = "en_US.UTF-8";
    const sentinel = "synthetic-explicit-terminal";
    const prepared = await prepareSshSandboxExec({
      session,
      remoteCommand: "'/bin/sh' '-c' 'printf %s \"$TERM\"'",
      env: { TERM: sentinel },
      tty: true,
    });

    const options = spawnCommandOptions();
    expect(options.baseEnv.OPENAI_API_KEY).toBeUndefined();
    expect(options.baseEnv.LANG).toBe("en_US.UTF-8");
    expect(options.maxBuffer).toBe(SANDBOX_COMMAND_MAX_BUFFER_BYTES);

    const uploadArgv = spawnCommandMock.mock.calls[0]?.[0] as string[];
    const uploadOptions = spawnCommandMock.mock.calls[0]?.[1] as { input?: string };
    expect(uploadArgv).toContain("-T");
    expect(uploadArgv.join(" ")).not.toContain(sentinel);
    expect(uploadOptions.input).toContain(`export TERM='${sentinel}'`);
    expect(prepared.argv).toContain("-tt");
    expect(prepared.argv).toContain("RequestTTY=force");
    expect(prepared.argv.join(" ")).not.toContain(sentinel);
    expect(prepared.argv.join(" ")).not.toContain("SetEnv");

    await prepared.cleanup();
    expect(spawnCommandMock).toHaveBeenCalledTimes(2);
  });

  it("removes remote SSH staging after an upload failure", async () => {
    const sentinel = "synthetic-failed-upload-value";
    spawnCommandMock.mockResolvedValueOnce({
      failed: false,
      isCanceled: false,
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("synthetic staging failure"),
    });

    await expect(
      prepareSshSandboxExec({
        session,
        remoteCommand: "'/bin/sh' '-c' 'true'",
        env: { SYNTHETIC_VALUE: sentinel },
      }),
    ).rejects.toThrow("synthetic staging failure");

    expect(spawnCommandMock).toHaveBeenCalledTimes(2);
    const uploadArgv = spawnCommandMock.mock.calls[0]?.[0] as string[];
    const uploadOptions = spawnCommandMock.mock.calls[0]?.[1] as { input?: string };
    const cleanupArgv = spawnCommandMock.mock.calls[1]?.[0] as string[];
    expect(uploadArgv.join(" ")).not.toContain(sentinel);
    expect(uploadOptions.input).toContain(sentinel);
    expect(cleanupArgv.at(-1)).toContain("openclaw-sandbox-exec-cleanup");
    expect(cleanupArgv.join(" ")).not.toContain(sentinel);
  });

  it("rejects transport failures even when ssh exits zero", async () => {
    spawnCommandMock.mockResolvedValueOnce(
      Object.assign(new Error("ssh stream failed"), {
        failed: true,
        isCanceled: false,
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }),
    );

    await expect(
      runSshSandboxCommand({
        session,
        remoteCommand: "true",
      }),
    ).rejects.toThrow("ssh stream failed");
  });

  it.each(["authority revocation", "cancellation"] as const)(
    "does not spawn an upload after %s during local traversal",
    async (reason) => {
      let current = true;
      const controller = new AbortController();
      const localDir = ownedDirs.make("openclaw-ssh-upload-admission-");
      await fs.writeFile(path.join(localDir, "payload.txt"), "synthetic payload");
      spawnMock.mockImplementation(() => {
        throw new Error("unexpected native spawn");
      });
      try {
        const uploading = uploadDirectoryToSshTarget({
          session: {
            ...session,
            assertCurrent: () => {
              if (!current) {
                throw new Error("runtime removed");
              }
            },
          },
          localDir,
          remoteDir: "/remote/workspace",
          signal: controller.signal,
        });
        if (reason === "authority revocation") {
          current = false;
        } else {
          controller.abort(new Error("upload cancelled"));
        }
        await expect(uploading).rejects.toThrow(
          reason === "authority revocation" ? "runtime removed" : "upload cancelled",
        );
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        spawnMock.mockReset();
      }
    },
  );

  it("filters blocked secrets before spawning ssh uploads", async () => {
    mockSuccessfulSpawnCalls(2);

    process.env.ANTHROPIC_API_KEY = "x";
    process.env.NODE_ENV = "test";
    const localDir = ownedDirs.make("openclaw-ssh-upload-env-");

    await uploadDirectoryToSshTarget({
      session,
      localDir,
      remoteDir: "/remote/workspace",
    });

    const env = spawnOptionsAt(1).env;
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.NODE_ENV).toBe("test");
  });

  it.runIf(process.platform !== "win32")(
    "allows in-workspace symlinks to upload normally",
    async () => {
      mockSuccessfulSpawnCalls(2);

      const localDir = ownedDirs.make("openclaw-ssh-upload-safe-");
      await fs.mkdir(path.join(localDir, "real"), { recursive: true });
      await fs.writeFile(path.join(localDir, "real", "payload.txt"), "ok\n", "utf8");
      await fs.symlink("real", path.join(localDir, "linked-dir"));

      await uploadDirectoryToSshTarget({
        session,
        localDir,
        remoteDir: "/remote/workspace",
      });

      expect(spawnMock).toHaveBeenCalledTimes(2);
    },
  );
});

describe("SSH sandbox stream errors", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let localDir: string;
  beforeAll(() => {
    localDir = tempDirs.make("openclaw-ssh-stream-test-");
  });
  beforeEach(() => spawnMock.mockReset());
  it.each([
    { process: "tar", code: "EMFILE" },
    { process: "ssh", code: "EMFILE" },
  ] as const)(
    "preserves $process $code without streams and waits for both children to close",
    async ({ process: childName, code }) => {
      const failed = Object.assign(new EventEmitter(), { kill: vi.fn(() => false) });
      const peer = createMockChildProcess();
      const tar = childName === "tar" ? failed : peer;
      const ssh = childName === "ssh" ? failed : peer;
      const nativeError = Object.assign(new Error(`spawn ${childName} ${code}`), { code });
      const errorEmitted = createDeferred();
      // Keep the intentionally broken baseline from crashing this test worker.
      failed.on("error", () => errorEmitted.resolve());
      const returnChild = (child: typeof failed | MockChildProcess) => {
        if (child === failed) {
          queueMicrotask(() => failed.emit("error", nativeError));
        }
        return child;
      };
      spawnMock
        .mockImplementationOnce(() => returnChild(tar))
        .mockImplementationOnce(() => returnChild(ssh));
      let completed = false;
      const result = uploadDirectoryToSshTarget({
        session,
        localDir,
        remoteDir: "/remote/workspace",
      }).then(
        () => {
          completed = true;
          return undefined;
        },
        (error: unknown) => {
          completed = true;
          return error;
        },
      );
      try {
        await awaitGateBeforeSettlement(
          errorEmitted.promise,
          result,
          "native spawn error did not arrive",
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completed).toBe(false);
        expect(peer.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        failed.emit("close", -24, null);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completed).toBe(false);
        peer.emit("close", null, "SIGKILL");
        expect(await result).toBe(nativeError);
      } finally {
        failed.emit("close", -24, null);
        peer.emit("close", null, "SIGKILL");
        await result;
      }
    },
  );

  it.each([
    { process: "tar", stream: "stdout" },
    { process: "ssh", stream: "stdin" },
  ] as const)(
    "reaps both upload children before rejecting $process $stream failure",
    async ({ process: childName, stream: streamName }) => {
      const tar = createMockChildProcess();
      const ssh = createMockChildProcess();
      const childrenSpawned = createDeferred();
      spawnMock.mockReturnValueOnce(tar as unknown as ChildProcess).mockImplementationOnce(() => {
        childrenSpawned.resolve();
        return ssh as unknown as ChildProcess;
      });
      const expected = `${childName}.${streamName} failed`;
      let completed = false;
      const result = uploadDirectoryToSshTarget({
        session,
        localDir,
        remoteDir: "/remote/workspace",
      });
      const rejection = result.then(
        () => {
          throw new Error(`expected rejection: ${expected}`);
        },
        (error: unknown) => {
          completed = true;
          expect(error).toEqual(expect.objectContaining({ message: expected }));
        },
      );
      await awaitGateBeforeSettlement(
        childrenSpawned.promise,
        result,
        "tar/ssh upload children did not spawn",
      );
      expect(spawnMock).toHaveBeenCalledTimes(2);
      const failedChild = { tar, ssh }[childName];
      const emitError = (message: string) => {
        failedChild[streamName].emit("error", new Error(message));
      };

      emitError(expected);
      emitError("later upload failure");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(completed).toBe(false);
      expect(tar.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(ssh.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");

      tar.emit("close", null, "SIGKILL");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(completed).toBe(false);
      ssh.emit("close", null, "SIGKILL");
      await rejection;
      emitError("late stream error");
      expect(tar.kill).toHaveBeenCalledOnce();
      expect(ssh.kill).toHaveBeenCalledOnce();
    },
  );
});
