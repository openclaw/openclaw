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

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const commandResult = (
  overrides: Partial<{ failed: boolean; exitCode: number; stderr: Buffer }> = {},
) => ({
  failed: false,
  isCanceled: false,
  exitCode: 0,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  ...overrides,
});

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnCommandMock,
}));

function mockSuccessfulSpawnCalls(times = 1) {
  for (let i = 0; i < times; i += 1) {
    spawnMock.mockImplementationOnce(() => {
      const child = createMockChildProcess();
      process.nextTick(() => child.emit("close", 0));
      return child;
    });
  }
}

let runSshSandboxCommand: typeof import("./ssh.js").runSshSandboxCommand;
let prepareSshSandboxExec: typeof import("./ssh.js").prepareSshSandboxExec;
let uploadDirectoryToSshTarget: typeof import("./ssh.js").uploadDirectoryToSshTarget;

beforeAll(async () => {
  vi.resetModules();
  ({ prepareSshSandboxExec, runSshSandboxCommand, uploadDirectoryToSshTarget } =
    await import("./ssh.js"));
});

const prepare = (env: Record<string, string>, tty = false) =>
  prepareSshSandboxExec({ session, remoteCommand: "'/bin/sh' '-c' 'true'", env, tty });
const upload = (localDir: string) =>
  uploadDirectoryToSshTarget({ session, localDir, remoteDir: "/remote/workspace" });

function expectPrivateStaging(sentinel: string, expectedInput = sentinel) {
  const [argv, options] = spawnCommandMock.mock.calls[0] as [string[], { input: string }];
  expect(argv.join(" ")).not.toContain(sentinel);
  expect(options.input).toContain(expectedInput);
  return argv;
}

describe("ssh subprocess env sanitization", () => {
  const ownedDirs = useAutoCleanupTempDirTracker(afterEach);
  let envSnapshot: ReturnType<typeof captureFullEnv>;

  beforeEach(() => {
    envSnapshot = captureFullEnv();
    vi.clearAllMocks();
    spawnCommandMock.mockResolvedValue(commandResult());
  });

  afterEach(() => envSnapshot.restore());

  it.each([
    ["PADDED_NAME ", "", ["POSIX variable name"]],
    ["SYNTHETIC_VALUE", "\0suffix", ["SYNTHETIC_VALUE", "NUL"]],
  ] as const)(
    "rejects invalid SSH environment %s without exposing values",
    async (name, suffix, messages) => {
      const sentinel = "synthetic-invalid-name-value";
      await expect(prepare({ [name]: `${sentinel}${suffix}` })).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          const message = (error as Error).message;
          for (const expected of messages) {
            expect(message).toContain(expected);
          }
          expect(message).not.toContain(sentinel);
          return true;
        },
      );
      expect(spawnCommandMock).not.toHaveBeenCalled();
    },
  );

  it("preserves explicit TTY terminal values in staged stdin without SSH SetEnv", async () => {
    process.env.OPENAI_API_KEY = "x";
    process.env.LANG = "en_US.UTF-8";
    const sentinel = "synthetic-explicit-terminal";
    const prepared = await prepare({ TERM: sentinel }, true);
    expect(spawnCommandMock.mock.calls[0]?.[1]).toMatchObject({
      baseEnv: { LANG: "en_US.UTF-8" },
      maxBuffer: SANDBOX_COMMAND_MAX_BUFFER_BYTES,
    });
    expect(spawnCommandMock.mock.calls[0]?.[1]?.baseEnv?.OPENAI_API_KEY).toBeUndefined();
    const uploadArgv = expectPrivateStaging(sentinel, `export TERM='${sentinel}'`);
    expect(uploadArgv).toContain("-T");
    expect(prepared.argv).toEqual(expect.arrayContaining(["-tt", "RequestTTY=force"]));
    expect(prepared.argv.join(" ")).not.toContain(sentinel);
    expect(prepared.argv.join(" ")).not.toContain("SetEnv");

    await prepared.cleanup();
    expect(spawnCommandMock).toHaveBeenCalledTimes(2);
  });

  it("removes remote SSH staging after an upload failure", async () => {
    const sentinel = "synthetic-failed-upload-value";
    spawnCommandMock.mockResolvedValueOnce(
      commandResult({
        exitCode: 1,
        stderr: Buffer.from("synthetic staging failure"),
      }),
    );

    await expect(prepare({ SYNTHETIC_VALUE: sentinel })).rejects.toThrow(
      "synthetic staging failure",
    );

    expect(spawnCommandMock).toHaveBeenCalledTimes(2);
    expectPrivateStaging(sentinel);
    const cleanupArgv = spawnCommandMock.mock.calls[1]?.[0] as string[];
    expect(cleanupArgv.at(-1)).toContain("openclaw-sandbox-exec-cleanup");
    expect(cleanupArgv.join(" ")).not.toContain(sentinel);
  });

  it("rejects transport failures even when ssh exits zero", async () => {
    spawnCommandMock.mockResolvedValueOnce(
      Object.assign(new Error("ssh stream failed"), commandResult({ failed: true })),
    );

    await expect(runSshSandboxCommand({ session, remoteCommand: "true" })).rejects.toThrow(
      "ssh stream failed",
    );
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

    await upload(localDir);
    expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({
      env: { NODE_ENV: "test" },
    });
    expect(spawnMock.mock.calls[1]?.[2]?.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "allows in-workspace symlinks to upload normally",
    async () => {
      mockSuccessfulSpawnCalls(2);

      const localDir = ownedDirs.make("openclaw-ssh-upload-safe-");
      await fs.mkdir(path.join(localDir, "real"), { recursive: true });
      await fs.writeFile(path.join(localDir, "real", "payload.txt"), "ok\n", "utf8");
      await fs.symlink("real", path.join(localDir, "linked-dir"));

      await upload(localDir);

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
    ["tar", null],
    ["ssh", null],
    ["tar", "stdout"],
    ["ssh", "stdin"],
  ] as const)(
    "preserves %s %s failure and reaps both children before settling",
    async (childName, streamName) => {
      const native = streamName === null;
      const streamed = createMockChildProcess();
      const failed = native
        ? Object.assign(new EventEmitter(), { kill: vi.fn(() => false) })
        : streamed;
      const peer = createMockChildProcess();
      const children = childName === "tar" ? [failed, peer] : [peer, failed];
      const error = Object.assign(new Error(`${childName}.${streamName ?? "spawn"} failed`), {
        code: "EMFILE",
      });
      const ready = createDeferred();
      if (native) {
        failed.on("error", () => ready.resolve());
      }
      children.forEach((child, index) => {
        spawnMock.mockImplementationOnce(() => {
          if (native && child === failed) {
            queueMicrotask(() => failed.emit("error", error));
          } else if (!native && index === 1) {
            ready.resolve();
          }
          return child;
        });
      });
      let completed = false;
      const result = upload(localDir)
        .catch((failure: unknown) => failure)
        .finally(() => {
          completed = true;
        });
      try {
        await awaitGateBeforeSettlement(ready.promise, result, "upload failure gate not reached");
        const emitStreamError = (message: string) => {
          if (streamName) {
            streamed[streamName].emit("error", new Error(message));
          }
        };
        if (!native) {
          expect(spawnMock).toHaveBeenCalledTimes(2);
          emitStreamError(error.message);
          emitStreamError("later upload failure");
        }
        await nextTurn();
        expect(completed).toBe(false);
        expect(peer.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        if (!native) {
          expect(failed.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        }
        const first = native ? failed : children[0];
        const last = native ? peer : children[1];
        first.emit("close", native ? -24 : null, native ? null : "SIGKILL");
        await nextTurn();
        expect(completed).toBe(false);
        last.emit("close", null, "SIGKILL");
        if (native) {
          expect(await result).toBe(error);
        } else {
          expect(await result).toMatchObject({ message: error.message });
          emitStreamError("late stream error");
          expect(failed.kill).toHaveBeenCalledOnce();
          expect(peer.kill).toHaveBeenCalledOnce();
        }
      } finally {
        failed.emit("close", -24, null);
        peer.emit("close", null, "SIGKILL");
        await result;
      }
    },
  );
});
