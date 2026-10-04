import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSignalSocketEndpoint, prepareSignalSocketPath } from "./socket-path.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fsMocks = vi.hoisted(() => ({ actualLstat: vi.fn(), lstat: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.actualLstat.mockImplementation(actual.lstat);
  fsMocks.lstat.mockImplementation(actual.lstat);
  return { ...actual, lstat: fsMocks.lstat };
});

async function withSocket(socketPath: string, run: (server: Server) => Promise<void>) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(server);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function withStaleSocket(socketPath: string, run: () => Promise<void>) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))",
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await once(child.stdout, "data");
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    await run();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  }
}

describe.skipIf(process.platform === "win32")("Signal socket filesystem boundary", () => {
  let root: string;
  beforeEach(async () => {
    root = tempDirs.make("oc-sig-", await realpath(os.tmpdir()));
  });
  afterEach(() => {
    fsMocks.lstat.mockImplementation(fsMocks.actualLstat);
  });

  it("creates a private immediate parent and accepts only an owned socket endpoint", async () => {
    const socketPath = path.join(root, "private", "rpc");
    await prepareSignalSocketPath(socketPath);
    expect((await lstat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    await withSocket(socketPath, async (server) => {
      await expect(assertSignalSocketEndpoint(socketPath)).resolves.toBeUndefined();
      await expect(prepareSignalSocketPath(socketPath)).rejects.toThrow("already exists");
      expect(server.listening).toBe(true);
    });
  });

  it.each([
    { mode: 0o755, privateChild: false },
    { mode: 0o770, privateChild: false },
    { mode: 0o777, privateChild: true },
  ])(
    "rejects nonprivate directories ($mode, child=$privateChild) without changing permissions",
    async ({ mode, privateChild }) => {
      const parent = privateChild ? path.join(root, "private") : root;
      if (privateChild) {
        await mkdir(parent, { mode: 0o700 });
      }
      await chmod(root, mode);
      if (privateChild) {
        await expect(assertSignalSocketEndpoint(path.join(parent, "rpc"))).rejects.toThrow(
          "ancestors",
        );
      } else {
        await expect(prepareSignalSocketPath(path.join(parent, "rpc"))).rejects.toThrow();
      }
      expect((await lstat(root)).mode & 0o777).toBe(mode);
    },
  );

  it("rejects a symlink parent and does not touch its target", async () => {
    const target = path.join(root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.join(root, "alias"));
    await expect(prepareSignalSocketPath(path.join(root, "alias", "rpc"))).rejects.toThrow(
      "symlinks",
    );
    expect((await lstat(target)).mode & 0o777).toBe(0o700);
  });

  it("preserves existing files and rejects them as socket endpoints", async () => {
    const socketPath = path.join(root, "rpc");
    await writeFile(socketPath, "not a socket");
    await expect(prepareSignalSocketPath(socketPath)).rejects.toThrow("already exists");
    await expect(assertSignalSocketEndpoint(socketPath)).rejects.toThrow("must name a socket");
    expect((await lstat(socketPath)).isFile()).toBe(true);
  });

  it("rejects a socket endpoint reported as owned by another uid", async () => {
    const socketPath = path.join(root, "rpc");
    await withSocket(socketPath, async () => {
      fsMocks.lstat.mockImplementation(async (entryPath, ...args) => {
        const stat = await fsMocks.actualLstat(entryPath, ...args);
        if (entryPath !== socketPath) {
          return stat;
        }
        return new Proxy(stat, {
          get: (target, property, receiver) =>
            property === "uid"
              ? (process.getuid?.() ?? 0) + 1
              : Reflect.get(target, property, receiver),
        });
      });
      await expect(assertSignalSocketEndpoint(socketPath)).rejects.toThrow(
        "socket owned by the current user",
      );
    });
  });

  it.each([false, true])(
    "recovers only an unchanged stale owned socket (replaced=%s)",
    async (replaced) => {
      const socketPath = path.join(root, "rpc");
      await withStaleSocket(socketPath, async () => {
        expect((await lstat(socketPath)).isSocket()).toBe(true);
        let endpointStats = 0;
        if (replaced) {
          fsMocks.lstat.mockImplementation(async (entryPath, ...args) => {
            const stat = await fsMocks.actualLstat(entryPath, ...args);
            if (entryPath !== socketPath || ++endpointStats !== 2) {
              return stat;
            }
            return new Proxy(stat, {
              get: (target, property, receiver) =>
                property === "ino"
                  ? Number(target.ino) + 1
                  : Reflect.get(target, property, receiver),
            });
          });
        }
        const preparation = prepareSignalSocketPath(socketPath);
        if (replaced) {
          await expect(preparation).rejects.toThrow("changed during its ownership probe");
          expect((await fsMocks.actualLstat(socketPath)).isSocket()).toBe(true);
        } else {
          await expect(preparation).resolves.toBeUndefined();
          await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it("does not probe or remove an existing socket when startup was cancelled", async () => {
    const socketPath = path.join(root, "rpc");
    await writeFile(socketPath, "preserve");
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(prepareSignalSocketPath(socketPath, abort.signal)).rejects.toThrow("cancelled");
    expect((await lstat(socketPath)).isFile()).toBe(true);
  });

  it("rejects traversal syntax and oversized paths before creating anything", async () => {
    await expect(prepareSignalSocketPath(`${root}/child/../rpc`)).rejects.toThrow(
      "normalized absolute",
    );
    await expect(prepareSignalSocketPath(`${root}/${"x".repeat(104)}`)).rejects.toThrow(
      "103 UTF-8 bytes",
    );
  });
});

describe.skipIf(process.platform !== "darwin")("Signal socket macOS ACL boundary", () => {
  let root: string;
  beforeEach(async () => {
    root = tempDirs.make("oc-sig-acl-", await realpath(os.tmpdir()));
  });
  afterEach(() => {
    fsMocks.lstat.mockImplementation(fsMocks.actualLstat);
  });

  it.each([false, true])("rejects parent ACL access (inherited=%s)", async (inherited) => {
    await execFileAsync("/bin/chmod", [
      "+a",
      inherited ? "everyone allow search,file_inherit,directory_inherit" : "everyone allow search",
      root,
    ]);
    const parent = inherited ? path.join(root, "private") : root;
    await expect(prepareSignalSocketPath(path.join(parent, "rpc"))).rejects.toThrow("ACL access");
    if (inherited) {
      await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects a socket endpoint with an access-granting ACL", async () => {
    const socketPath = path.join(root, "rpc");
    await withSocket(socketPath, async () => {
      await execFileAsync("/bin/chmod", ["+a", "everyone allow write", socketPath]);
      await expect(assertSignalSocketEndpoint(socketPath)).rejects.toThrow("ACL access");
    });
  });
});
