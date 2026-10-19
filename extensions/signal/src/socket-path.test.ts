import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSignalSocketEndpoint as assertEndpoint,
  prepareSignalSocketPath as prepare,
} from "./socket-path.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fsMocks = vi.hoisted(() => ({ actualLstat: vi.fn(), lstat: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.actualLstat.mockImplementation(actual.lstat);
  fsMocks.lstat.mockImplementation(actual.lstat);
  return { ...actual, lstat: fsMocks.lstat };
});

function mockSocketStat(socketPath: string, property: "uid" | "ino", onRead?: number) {
  let reads = 0;
  fsMocks.lstat.mockImplementation(async (entryPath, ...args) => {
    const stat = await fsMocks.actualLstat(entryPath, ...args);
    if (entryPath !== socketPath || (onRead !== undefined && ++reads !== onRead)) {
      return stat;
    }
    const value = property === "uid" ? (process.getuid?.() ?? 0) + 1 : Number(stat.ino) + 1;
    return Object.assign(stat, { [property]: value });
  });
}

const servers = new Set<Server>();
async function listen(endpoint = socketPath) {
  const server = createServer();
  servers.add(server);
  const listening = once(server, "listening");
  server.listen(endpoint);
  await listening;
  return server;
}

async function createStaleSocket() {
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
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  }
}

let root: string;
let socketPath: string;
beforeEach(() => {
  root = tempDirs.make("oc-sig-");
  socketPath = path.join(root, "rpc");
});
afterEach(async () => {
  for (const server of servers) {
    await promisify(server.close.bind(server))();
  }
  servers.clear();
  fsMocks.lstat.mockImplementation(fsMocks.actualLstat);
});

describe.skipIf(process.platform === "win32")("Signal socket filesystem boundary", () => {
  it("creates a private immediate parent and accepts only an owned socket endpoint", async () => {
    socketPath = path.join(root, "private", "rpc");
    await prepare(socketPath);
    expect((await lstat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    const server = await listen(socketPath);
    await expect(assertEndpoint(socketPath)).resolves.toBeUndefined();
    await expect(prepare(socketPath)).rejects.toThrow("already exists");
    expect(server.listening).toBe(true);
  });

  it.each([0o755, 0o770, 0o777])(
    "preserves nonprivate directory permissions (%s)",
    async (mode) => {
      const privateChild = mode === 0o777;
      const parent = privateChild ? path.join(root, "private") : root;
      if (privateChild) {
        await mkdir(parent, { mode: 0o700 });
      }
      await chmod(root, mode);
      await expect(
        (privateChild ? assertEndpoint : prepare)(path.join(parent, "rpc")),
      ).rejects.toThrow(privateChild ? "ancestors" : undefined);
      expect((await lstat(root)).mode & 0o777).toBe(mode);
    },
  );

  it("rejects a symlink parent and does not touch its target", async () => {
    const target = path.join(root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.join(root, "alias"));
    await expect(prepare(path.join(root, "alias", "rpc"))).rejects.toThrow("symlinks");
    expect((await lstat(target)).mode & 0o777).toBe(0o700);
  });

  it.each([false, true])("preserves existing files (cancelled=%s)", async (cancelled) => {
    await writeFile(socketPath, "not a socket");
    const abort = new AbortController();
    if (cancelled) {
      abort.abort(new Error("cancelled"));
    }
    await expect(prepare(socketPath, abort.signal)).rejects.toThrow(
      cancelled ? "cancelled" : "already exists",
    );
    if (!cancelled) {
      await expect(assertEndpoint(socketPath)).rejects.toThrow("must name a socket");
    }
    expect((await lstat(socketPath)).isFile()).toBe(true);
  });

  it("rejects a socket endpoint reported as owned by another uid", async () => {
    await listen();
    mockSocketStat(socketPath, "uid");
    await expect(assertEndpoint(socketPath)).rejects.toThrow("socket owned by the current user");
  });

  it.each([false, true])("recovers stale sockets (replaced=%s)", async (replaced) => {
    await createStaleSocket();
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    if (replaced) {
      mockSocketStat(socketPath, "ino", 2);
    }
    const preparation = prepare(socketPath);
    if (replaced) {
      await expect(preparation).rejects.toThrow("changed during its ownership check");
      expect((await fsMocks.actualLstat(socketPath)).isSocket()).toBe(true);
    } else {
      await expect(preparation).resolves.toBeUndefined();
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects traversal syntax and oversized paths before creating anything", async () => {
    await expect(prepare(`${root}/child/../rpc`)).rejects.toThrow("normalized absolute");
    await expect(prepare(`${root}/${"x".repeat(104)}`)).rejects.toThrow("103 UTF-8 bytes");
  });
});

describe.skipIf(process.platform !== "darwin")("Signal socket macOS ACL boundary", () => {
  it.each([false, true])("rejects parent ACL access (inherited=%s)", async (inherited) => {
    await execFileAsync("/bin/chmod", [
      "+a",
      inherited ? "everyone allow search,file_inherit,directory_inherit" : "everyone allow search",
      root,
    ]);
    const parent = inherited ? path.join(root, "private") : root;
    await expect(prepare(path.join(parent, "rpc"))).rejects.toThrow("ACL access");
    if (inherited) {
      await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects a socket endpoint with an access-granting ACL", async () => {
    await listen();
    await execFileAsync("/bin/chmod", ["+a", "everyone allow write", socketPath]);
    await expect(assertEndpoint(socketPath)).rejects.toThrow("ACL access");
  });
});
