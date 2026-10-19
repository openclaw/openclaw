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
  expect(await handleDirList(input)).toMatchObject({ ok: false, code });
}

async function listingCommand(directoryPath: string, canonical = directoryPath) {
  const stats = await fs.stat(canonical, { bigint: true });
  return createCanonicalDirListCommand({
    directoryPath,
    expectedCanonicalPath: canonical,
    expectedDevice: String(stats.dev),
    expectedInode: String(stats.ino),
    maxEntries: 10,
    offset: 0,
  });
}

function spawnCommand(command: string[], prefix: string, event: "close" | "exit") {
  const child = spawn(command[0]!, [command[1]!, prefix + command[2]!, ...command.slice(3)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once(event, resolve);
  });
  return { child, stdout, stderr, exit };
}

async function list(input: Parameters<typeof handleDirList>[0]) {
  const result = await handleDirList(input);
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result;
}

function failure(code: string, message: string, canonicalPath?: string) {
  return { ok: false, code, message, ...(canonicalPath === undefined ? {} : { canonicalPath }) };
}

describe("handleDirList", () => {
  it("rejects empty / non-string path", async () => {
    await expectDirListError({ path: "" }, "INVALID_PATH");
    await expectDirListError({ path: undefined }, "INVALID_PATH");
  });
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
      ).resolves.toEqual(
        failure(
          "CANONICAL_PATH_CHANGED",
          "filesystem identity differs from the authorized target",
          tmpRoot,
        ),
      );
      expect(readdir).not.toHaveBeenCalled();
    },
  );
  it("preserves path and directory errors before validating the binding", async () => {
    const missing = path.join(tmpRoot, "missing");
    await expect(handleDirList({ path: missing, expectedBinding: null })).resolves.toEqual(
      failure("NOT_FOUND", "path not found"),
    );
    const file = path.join(tmpRoot, "file.txt");
    await fs.writeFile(file, "keep");
    await expect(handleDirList({ path: file, expectedBinding: null })).resolves.toEqual(
      failure("IS_FILE", "path is not a directory", file),
    );
    await expect(
      handleDirList({ path: file, expectedCanonicalPath: tmpRoot, expectedBinding: null }),
    ).resolves.toEqual(
      failure("CANONICAL_PATH_CHANGED", "resolved path differs from the authorized target", file),
    );
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

      await expect(handle({ path: tmpRoot, expectedBinding: null })).resolves.toEqual(
        failure(permissionCode, "stat failed: Error: denied", tmpRoot),
      );
    },
  );
  it.runIf(process.platform === "linux")("keeps enumeration bound after retargeting", async () => {
    const approved = path.join(tmpRoot, "approved");
    const replacement = path.join(tmpRoot, "replacement");
    const current = path.join(tmpRoot, "current");
    await fs.mkdir(approved);
    await fs.mkdir(replacement);
    await fs.writeFile(path.join(approved, "approved.txt"), "approved");
    await fs.writeFile(path.join(replacement, "secret.txt"), "secret");
    await fs.symlink(approved, current);
    const command = await listingCommand(current, approved);
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
    const { child, stdout, stderr, exit } = spawnCommand(command, retargetAfterBinding, "close");
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
  });

  it.runIf(process.platform === "linux")(
    "rejects a same-path replacement before binding",
    async () => {
      const approved = path.join(tmpRoot, "approved");
      const moved = path.join(tmpRoot, "moved");
      await fs.mkdir(approved);
      await fs.writeFile(path.join(approved, "approved.txt"), "approved");
      const command = await listingCommand(approved);
      await fs.rename(approved, moved);
      await fs.mkdir(approved);
      await fs.writeFile(path.join(approved, "secret.txt"), "secret");

      const drained = path.join(tmpRoot, "rejected-worker-drained");
      const observeNaturalExit = `process.once("beforeExit", () => require("node:fs").writeFileSync(${JSON.stringify(drained)}, "settled"));`;
      const { stdout, exit } = spawnCommand(command, observeNaturalExit, "exit");
      expect(await exit).toBe(78);
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
    expect(changed).toEqual(
      failure(
        "CANONICAL_PATH_CHANGED",
        "resolved path differs from the authorized target",
        tmpRoot,
      ),
    );
  });

  it("lists files and subdirs with metadata, sorted by name", async () => {
    await fs.writeFile(path.join(tmpRoot, ".hidden"), "Z");
    await fs.writeFile(path.join(tmpRoot, "a.png"), "PNG-bytes");
    await fs.mkdir(path.join(tmpRoot, "subdir"));

    const r = await list({ path: tmpRoot });
    expect(r.entries.map((e) => e.name)).toEqual([".hidden", "a.png", "subdir"]);

    const a = r.entries.find((e) => e.name === "a.png")!;
    expect(a.size).toBeGreaterThan(0);
    expect(a).toMatchObject({ isDir: false, mimeType: "image/png" });
    const sub = r.entries.find((e) => e.name === "subdir")!;
    expect(sub).toMatchObject({ isDir: true, size: 0, mimeType: "inode/directory" });

    expect(r.truncated).toBe(false);
    expect(r.nextPageToken).toBeUndefined();
  });

  it.each([
    ["partial token", "1next", "f-0.txt", "1"],
    ["plus-signed token", "+01", "f-1.txt", "2"],
  ])("paginates a %s", async (_name, pageToken, entry, nextPageToken) => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmpRoot, `f-${i}.txt`), "x");
    }

    const r = await list({ path: tmpRoot, maxEntries: 1, pageToken });
    expect(r.entries.map((e) => e.name)).toEqual([entry]);
    expect(r.nextPageToken).toBe(nextPageToken);
  });
});
