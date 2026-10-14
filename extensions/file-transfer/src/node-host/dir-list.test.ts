// File Transfer tests cover dir list plugin behavior.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDirFetch } from "./dir-fetch.js";
import { createCanonicalDirListCommand } from "./dir-list-worker-command.js";
import { handleDirList } from "./dir-list.js";

let tmpRoot: string;

beforeEach(async () => {
  // realpath: see file-fetch.test.ts for the macOS symlinked-tmpdir reason.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-list-test-")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function expectDirListError(
  input: Parameters<typeof handleDirList>[0],
  code: "INVALID_PATH" | "IS_FILE" | "NOT_FOUND",
) {
  const result = await handleDirList(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

describe("handleDirList — input validation", () => {
  it("rejects empty / non-string path", async () => {
    await expectDirListError({ path: "" }, "INVALID_PATH");
    await expectDirListError({ path: undefined }, "INVALID_PATH");
  });
});

describe("handleDirList — invalid directory bindings", () => {
  it.each(["malformed", "write", "device", "inode"] as const)(
    "rejects a %s binding before reading the directory",
    async (kind) => {
      const stats = await fs.stat(tmpRoot, { bigint: true });
      const binding = { kind: "existing", device: String(stats.dev), inode: String(stats.ino) };
      const expectedBinding = {
        malformed: null,
        write: {
          kind: "write",
          anchorPath: tmpRoot,
          anchorDevice: binding.device,
          anchorInode: binding.inode,
        },
        device: { ...binding, device: "different" },
        inode: { ...binding, inode: "different" },
      }[kind];
      const readdir = vi.spyOn(fs, "readdir");

      await expect(
        handleDirList({ path: tmpRoot, preflightOnly: true, expectedBinding }),
      ).resolves.toEqual({
        ok: false,
        code: "CANONICAL_PATH_CHANGED",
        message: "filesystem identity differs from the authorized target",
        canonicalPath: tmpRoot,
      });
      expect(readdir).not.toHaveBeenCalled();
    },
  );
});

describe("directory binding", () => {
  it("preserves path and directory errors before validating the binding", async () => {
    const missing = path.join(tmpRoot, "missing");
    await expect(handleDirList({ path: missing, expectedBinding: null })).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "path not found",
    });
    const file = path.join(tmpRoot, "file.txt");
    await fs.writeFile(file, "keep");
    await expect(handleDirList({ path: file, expectedBinding: null })).resolves.toEqual({
      ok: false,
      code: "IS_FILE",
      message: "path is not a directory",
      canonicalPath: file,
    });
    await expect(
      handleDirList({ path: file, expectedCanonicalPath: tmpRoot, expectedBinding: null }),
    ).resolves.toEqual({
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
      message: "resolved path differs from the authorized target",
      canonicalPath: file,
    });
  });

  it.each([
    ["dir.list", handleDirList, "PERMISSION_DENIED"],
    ["dir.fetch", handleDirFetch, "READ_ERROR"],
  ] as const)(
    "retains %s's permission-error classification",
    async (_command, handle, permissionCode) => {
      vi.spyOn(fs, "stat").mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );

      await expect(handle({ path: tmpRoot, expectedBinding: null })).resolves.toEqual({
        ok: false,
        code: permissionCode,
        message: "stat failed: Error: denied",
        canonicalPath: tmpRoot,
      });
    },
  );
});

describe("handleDirList — happy path", () => {
  it.runIf(process.platform === "linux")(
    "keeps enumeration bound after the checked path is retargeted",
    async () => {
      const approved = path.join(tmpRoot, "approved");
      const replacement = path.join(tmpRoot, "replacement");
      const current = path.join(tmpRoot, "current");
      await fs.mkdir(approved);
      await fs.mkdir(replacement);
      await fs.writeFile(path.join(approved, "approved.txt"), "approved");
      await fs.writeFile(path.join(replacement, "secret.txt"), "secret");
      await fs.symlink(approved, current);
      const approvedStats = await fs.stat(approved, { bigint: true });

      const command = createCanonicalDirListCommand({
        directoryPath: current,
        expectedCanonicalPath: approved,
        expectedDevice: String(approvedStats.dev),
        expectedInode: String(approvedStats.ino),
        maxEntries: 10,
        offset: 0,
      });
      const drained = path.join(tmpRoot, "worker-drained");
      // Retarget after the real chdir, before the unchanged worker checks and
      // enumerates its bound directory. Polling /proc can miss the entire child.
      // beforeExit also distinguishes natural settlement from any forced-exit alias.
      const retargetAfterBinding = `(() => {
        const fs = require("node:fs");
        process.once("beforeExit", () => fs.writeFileSync(${JSON.stringify(drained)}, "settled"));
        const chdir = process.chdir;
        process.chdir = (directory) => {
          chdir(directory);
          process.chdir = chdir;
          fs.unlinkSync(${JSON.stringify(current)});
          fs.symlinkSync(${JSON.stringify(replacement)}, ${JSON.stringify(current)});
        };
      })();`;
      const child = spawn(
        command[0]!,
        [command[1]!, retargetAfterBinding + command[2]!, ...command.slice(3)],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      try {
        expect(await exit, Buffer.concat(stderr).toString("utf8")).toBe(0);
        expect(await fs.readFile(drained, "utf8")).toBe("settled");
        expect(await fs.readlink(current)).toBe(replacement);
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
          entries: Array<{ name: string }>;
        };
        expect(result.entries.some((entry) => entry.name === "approved.txt")).toBe(true);
        expect(result.entries.some((entry) => entry.name === "secret.txt")).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await exit.catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a replacement created at the same canonical pathname before binding",
    async () => {
      const approved = path.join(tmpRoot, "approved");
      const moved = path.join(tmpRoot, "moved");
      await fs.mkdir(approved);
      await fs.writeFile(path.join(approved, "approved.txt"), "approved");
      const approvedStats = await fs.stat(approved, { bigint: true });
      await fs.rename(approved, moved);
      await fs.mkdir(approved);
      await fs.writeFile(path.join(approved, "secret.txt"), "secret");

      const command = createCanonicalDirListCommand({
        directoryPath: approved,
        expectedCanonicalPath: approved,
        expectedDevice: String(approvedStats.dev),
        expectedInode: String(approvedStats.ino),
        maxEntries: 10,
        offset: 0,
      });
      const drained = path.join(tmpRoot, "rejected-worker-drained");
      const observeNaturalExit = `process.once("beforeExit", () => require("node:fs").writeFileSync(${JSON.stringify(drained)}, "settled"));`;
      const child = spawn(
        command[0]!,
        [command[1]!, observeNaturalExit + command[2]!, ...command.slice(3)],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const stdout: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });

      expect(exit).toBe(78);
      expect(await fs.readFile(drained, "utf8")).toBe("settled");
      expect(Buffer.concat(stdout)).toHaveLength(0);
    },
  );

  it("binds the canonical target before listing entries", async () => {
    await fs.writeFile(path.join(tmpRoot, "private.txt"), "secret");
    const stats = await fs.stat(tmpRoot, { bigint: true });
    const binding = { kind: "existing", device: String(stats.dev), inode: String(stats.ino) };

    const preflight = await handleDirList({
      path: tmpRoot,
      preflightOnly: true,
      expectedBinding: { ...binding, extra: "not part of the binding" },
    });
    expect(preflight).toEqual({
      ok: true,
      path: tmpRoot,
      entries: [],
      truncated: false,
      preflight: true,
      binding,
    });

    const changed = await handleDirList({
      path: tmpRoot,
      expectedCanonicalPath: path.join(tmpRoot, "other"),
    });
    expect(changed).toEqual({
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
      message: "resolved path differs from the authorized target",
      canonicalPath: tmpRoot,
    });
  });

  it("lists files and subdirs with metadata, sorted by name", async () => {
    await fs.writeFile(path.join(tmpRoot, ".hidden"), "Z");
    await fs.writeFile(path.join(tmpRoot, "a.png"), "PNG-bytes");
    await fs.mkdir(path.join(tmpRoot, "subdir"));

    const r = await handleDirList({ path: tmpRoot });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    expect(r.entries.map((e) => e.name)).toEqual([".hidden", "a.png", "subdir"]);

    const a = r.entries.find((e) => e.name === "a.png")!;
    expect(a.isDir).toBe(false);
    expect(a.size).toBeGreaterThan(0);
    expect(a.mimeType).toBe("image/png");

    const sub = r.entries.find((e) => e.name === "subdir")!;
    expect(sub.isDir).toBe(true);
    expect(sub.size).toBe(0);
    expect(sub.mimeType).toBe("inode/directory");

    expect(r.truncated).toBe(false);
    expect(r.nextPageToken).toBeUndefined();
  });

  it("does not coerce partial page tokens", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmpRoot, `f-${i}.txt`), "x");
    }

    const r = await handleDirList({ path: tmpRoot, maxEntries: 1, pageToken: "1next" });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    expect(r.entries.map((e) => e.name)).toEqual(["f-0.txt"]);
    expect(r.nextPageToken).toBe("1");
  });

  it("accepts plus-signed page tokens", async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmpRoot, `f-${i}.txt`), "x");
    }

    const r = await handleDirList({ path: tmpRoot, maxEntries: 1, pageToken: "+01" });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    expect(r.entries.map((e) => e.name)).toEqual(["f-1.txt"]);
    expect(r.nextPageToken).toBe("2");
  });
});
