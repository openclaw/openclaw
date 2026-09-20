import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

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
  child.kill = vi.fn(() => true);
  return child;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let localDir: string;

let uploadDirectoryToSshTarget: typeof import("./ssh.js").uploadDirectoryToSshTarget;

beforeAll(async () => {
  vi.resetModules();
  ({ uploadDirectoryToSshTarget } = await import("./ssh.js"));
  localDir = tempDirs.make("openclaw-ssh-stream-test-");
});

beforeEach(() => {
  spawnMock.mockReset();
});

function fakeSession(): import("./ssh.js").SshSandboxSession {
  return {
    command: "ssh",
    configPath: "/tmp/ssh-config",
    host: "host",
  };
}

describe("SSH sandbox stream errors", () => {
  it.each([
    { process: "tar", code: "EMFILE" },
    { process: "tar", code: "ENFILE" },
    { process: "ssh", code: "EMFILE" },
    { process: "ssh", code: "ENFILE" },
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
        session: fakeSession(),
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
        await withTestTimeout(errorEmitted.promise, 10_000, "native spawn error did not arrive");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completed).toBe(false);
        expect(peer.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        failed.emit("close", code === "EMFILE" ? -24 : -23, null);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completed).toBe(false);
        peer.emit("close", null, "SIGKILL");
        expect(await result).toBe(nativeError);
      } finally {
        failed.emit("close", code === "EMFILE" ? -24 : -23, null);
        peer.emit("close", null, "SIGKILL");
        await result;
      }
    },
  );

  it.each([
    { process: "tar", stream: "stdout" },
    { process: "tar", stream: "stderr" },
    { process: "ssh", stream: "stdin" },
    { process: "ssh", stream: "stdout" },
    { process: "ssh", stream: "stderr" },
    { process: "tar", stream: "error" },
    { process: "ssh", stream: "error" },
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
        session: fakeSession(),
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
      await withTestTimeout(
        childrenSpawned.promise,
        10_000,
        "tar/ssh upload children did not spawn",
      );
      expect(spawnMock).toHaveBeenCalledTimes(2);
      const failedChild = { tar, ssh }[childName];
      const emitError = (message: string) => {
        if (streamName === "error") {
          failedChild.emit("error", new Error(message));
        } else {
          failedChild[streamName].emit("error", new Error(message));
        }
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
