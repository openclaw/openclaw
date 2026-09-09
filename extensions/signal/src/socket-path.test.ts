import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSignalSocketEndpoint, prepareSignalSocketPath } from "./socket-path.js";

describe.skipIf(process.platform === "win32")("Signal socket filesystem boundary", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(await realpath(os.tmpdir()), "oc-sig-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a private immediate parent and accepts only an owned socket endpoint", async () => {
    const socketPath = path.join(root, "private", "rpc");
    await prepareSignalSocketPath(socketPath);
    expect((await lstat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(assertSignalSocketEndpoint(socketPath)).resolves.toBeUndefined();
      await expect(prepareSignalSocketPath(socketPath)).rejects.toThrow("already exists");
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([0o755, 0o770, 0o777])(
    "rejects a nonprivate parent (%s) without changing its permissions",
    async (mode) => {
      await chmod(root, mode);
      await expect(prepareSignalSocketPath(path.join(root, "rpc"))).rejects.toThrow();
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

  it("rejects a replaceable ancestor even when the immediate parent is private", async () => {
    const parent = path.join(root, "private");
    await mkdir(parent, { mode: 0o700 });
    await chmod(root, 0o777);
    await expect(assertSignalSocketEndpoint(path.join(parent, "rpc"))).rejects.toThrow("ancestors");
  });

  it("preserves existing files and rejects them as socket endpoints", async () => {
    const socketPath = path.join(root, "rpc");
    await writeFile(socketPath, "not a socket");
    await expect(prepareSignalSocketPath(socketPath)).rejects.toThrow("already exists");
    await expect(assertSignalSocketEndpoint(socketPath)).rejects.toThrow("must name a socket");
    expect((await lstat(socketPath)).isFile()).toBe(true);
  });

  it("recovers a stale owned socket after an unclean daemon exit", async () => {
    const socketPath = path.join(root, "rpc");
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
      expect((await lstat(socketPath)).isSocket()).toBe(true);
      await expect(prepareSignalSocketPath(socketPath)).resolves.toBeUndefined();
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
  });

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
