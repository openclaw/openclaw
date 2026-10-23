import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
  replaceDirectoryContents,
  stageDirectoryContents,
} from "./mirror.js";
import { expectFiles, writeFiles } from "./openshell-fs.test-support.js";

let fixtureRoot: string;
let source: string;
let target: string;
let outside: string;
beforeEach(async () => {
  // Keep nested socket paths within macOS's 104-byte sockaddr_un.sun_path.
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oc-mir-"));
  source = path.join(fixtureRoot, "src");
  target = path.join(fixtureRoot, "dst");
  outside = path.join(fixtureRoot, "outside");
  await Promise.all([source, target, outside].map((dir) => fs.mkdir(dir)));
});
const replace = (excludeDirs?: readonly string[]) =>
  replaceDirectoryContents({ sourceDir: source, targetDir: target, excludeDirs });

async function expectPathMissing(targetPath: string): Promise<void> {
  const result = fs.lstat(targetPath);
  await expect(result).rejects.toBeInstanceOf(Error);
  await expect(result).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("replaceDirectoryContents", () => {
  it("unlinks target hardlinks before replacing host content", async () => {
    await fs.writeFile(path.join(outside, "original.txt"), "host-only");
    await fs.link(path.join(outside, "original.txt"), path.join(target, "a.txt"));
    await writeFiles(source, { "a.txt": "hello" });
    await writeFiles(target, { "old.txt": "stale" });

    await replace();

    await expectFiles(target, { "a.txt": "hello" });
    await expectFiles(outside, { "original.txt": "host-only" });
    await expectPathMissing(path.join(target, "old.txt"));
  });

  it("applies remote deletions and file-directory replacements without protected links", async () => {
    await writeFiles(target, {
      "deleted/nested/old.txt": "stale",
      "now-file/old.txt": "stale",
      "now-directory": "stale",
    });
    const files = { "now-file": "file", "now-directory/new.txt": "directory" };
    await writeFiles(source, files);
    await fs.mkdir(path.join(source, "empty-directory"));

    await replace();

    await expectPathMissing(path.join(target, "deleted"));
    await expectFiles(target, files);
    expect(await fs.readdir(path.join(target, "empty-directory"))).toEqual([]);
  });

  it("waits for in-flight copies before reporting a mirror failure", async () => {
    await writeFiles(source, { "nested/failed.txt": "failed", "nested/delayed.txt": "finished" });
    const failure = new Error("copy failed");
    const failedCopyStarted = createDeferred<void>();
    const delayedCopyStarted = createDeferred<void>();
    const releaseCopy = createDeferred<void>();
    const originalCopyFile = fs.copyFile;
    const copyFile = vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      if (from === path.join(source, "nested", "failed.txt")) {
        failedCopyStarted.resolve();
        throw failure;
      }
      delayedCopyStarted.resolve();
      await releaseCopy.promise;
      await originalCopyFile(from, to, mode);
    });
    let settled = false;
    const replacement = replace()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await Promise.all([failedCopyStarted.promise, delayedCopyStarted.promise]);
      await setImmediate();
      expect(settled).toBe(false);
      releaseCopy.resolve();
      expect(await replacement).toBe(failure);
      await expectFiles(target, { "nested/delayed.txt": "finished" });
    } finally {
      releaseCopy.resolve();
      await replacement;
      copyFile.mockRestore();
    }
  });

  it("preserves default excluded directories and metadata regardless of case", async () => {
    await writeFiles(source, {
      "Hooks/evil/handler.js": "// malicious",
      "git-hooks/pre-commit": "malicious",
      ".git/hooks/post-checkout": "malicious",
      "safe.txt": "ok",
    });
    const protectedFiles = {
      "hooks/trusted": "trusted",
      "git-hooks/trusted": "trusted",
      ".git/HEAD": "ref: refs/heads/main\n",
    };
    await writeFiles(target, protectedFiles);

    await replace(DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS);

    expect(await fs.readdir(target)).not.toContain("Hooks");
    expect(await fs.readFile(path.join(target, "safe.txt"), "utf8")).toBe("ok");
    await expectFiles(target, protectedFiles);
    for (const file of Object.keys(protectedFiles)) {
      expect(await fs.readdir(path.join(target, path.dirname(file)))).toEqual([
        path.basename(file),
      ]);
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves target-only special files and their ancestor directories",
    async () => {
      const nested = path.join(target, "nested");
      const fifoPath = path.join(nested, "host.fifo");
      const socketPath = path.join(nested, "host.sock");
      await fs.mkdir(nested);
      execFileSync("mkfifo", [fifoPath]);
      const server = net.createServer().listen(socketPath);
      await once(server, "listening");

      try {
        await replace();

        expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
        expect((await fs.lstat(socketPath)).isSocket()).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each(["directory", "symlink"] as const)(
    "preserves trusted host symlinks when their remote ancestor is %s",
    async (remoteAncestor) => {
      await fs.writeFile(path.join(outside, "canary.txt"), "host-only");
      const linkTargets = {
        "file-link": path.join(outside, "canary.txt"),
        "directory-link": outside,
        "dangling-link": "missing-relative-target",
      };
      const nested = path.join(target, "nested", "deeper");
      await fs.mkdir(nested, { recursive: true });
      for (const [name, destination] of Object.entries(linkTargets)) {
        await fs.symlink(destination, path.join(nested, name));
      }
      await fs.writeFile(path.join(nested, "deleted.txt"), "stale");
      await fs.symlink(outside, path.join(target, "linked-entry"));
      await stageDirectoryContents({ sourceDir: target, targetDir: source });

      await writeFiles(source, { "safe.txt": "ok", "linked-entry": "remote-plain-file" });
      await fs.rm(path.join(source, "nested"), { recursive: true });
      if (remoteAncestor === "directory") {
        await writeFiles(path.join(source, "nested/deeper"), {
          "file-link": "remote",
          "directory-link/new.txt": "remote",
        });
        await fs.symlink(outside, path.join(source, "nested", "deeper", "dangling-link"));
      } else if (remoteAncestor === "symlink") {
        await fs.symlink(outside, path.join(source, "nested"));
      }

      await replace();

      expect(await fs.readFile(path.join(target, "safe.txt"), "utf8")).toBe("ok");
      expect(await fs.readlink(path.join(target, "linked-entry"))).toBe(outside);
      for (const [name, destination] of Object.entries(linkTargets)) {
        expect(await fs.readlink(path.join(nested, name))).toBe(destination);
      }
      await expectPathMissing(path.join(nested, "deleted.txt"));
      expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("host-only");
      expect(await fs.readdir(outside)).toEqual(["canary.txt"]);
    },
  );
});

it.each([
  ["replace", replaceDirectoryContents],
  ["stage", stageDirectoryContents],
] as const)("%s copies content without symbolic links", async (_mode, copy) => {
  const files = { "safe.txt": "ok", "nested/file.txt": "nested" };
  await writeFiles(source, files);
  await fs.symlink("/tmp/host-secret", path.join(source, "escaped-link"));
  await fs.symlink("/tmp/host-secret-dir", path.join(source, "nested", "escaped-dir"));

  await copy({ sourceDir: source, targetDir: target });

  await expectFiles(target, files);
  await expectPathMissing(path.join(target, "escaped-link"));
  await expectPathMissing(path.join(target, "nested", "escaped-dir"));
});
