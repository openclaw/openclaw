/**
 * Tests apply_patch execution and path safety.
 * Covers host/sandbox file operations, workspace guards, symlink races, and
 * update hunk behavior.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createRebindableDirectoryAlias,
  withRealpathSymlinkRebindRace,
} from "../test-utils/symlink-rebind-race.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";
import { resolveSandboxFileMutationQueueKey } from "./sandbox/file-mutation-identity.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  // realpath: production sandbox checks compare against canonical paths; on macOS
  // os.tmpdir() is a /var -> /private/var symlink, which otherwise trips the guard.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-")));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withWorkspaceTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(process.cwd(), "openclaw-patch-workspace-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildAddFilePatch(targetPath: string): string {
  return `*** Begin Patch
*** Add File: ${targetPath}
+escaped
*** End Patch`;
}

it("fences apply_patch after a file read when permissions change", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "permission.txt");
    await fs.writeFile(target, "original\n");
    const generation = new AbortController();
    const readFile = fs.readFile.bind(fs);
    const read = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof readFile>) => {
        const value = await readFile(...args);
        if (args[0] === target) {
          generation.abort(new Error("Permission change"));
        }
        return value;
      });
    try {
      const tool = createApplyPatchTool({ cwd: dir, workspaceOnly: false });
      await expect(
        tool.execute(
          "permission-patch",
          {
            input:
              "*** Begin Patch\n*** Update File: permission.txt\n@@\n-original\n+replacement\n*** End Patch",
          },
          generation.signal,
        ),
      ).rejects.toThrow("Permission change");
    } finally {
      read.mockRestore();
    }
    expect(await fs.readFile(target, "utf8")).toBe("original\n");
  });
});

async function expectOutsideWriteRejected(params: {
  dir: string;
  patchTargetPath: string;
  outsidePath: string;
}) {
  const patch = buildAddFilePatch(params.patchTargetPath);
  await expect(applyPatch(patch, { cwd: params.dir })).rejects.toThrow(/Path escapes sandbox root/);
  await expectMissingPath(fs.readFile(params.outsidePath, "utf8"));
}

async function expectMissingPath(operation: Promise<unknown>) {
  let error: NodeJS.ErrnoException | undefined;
  try {
    await operation;
  } catch (caught) {
    error = caught as NodeJS.ErrnoException;
  }
  expect(error?.code).toBe("ENOENT");
}

describe("applyPatch", () => {
  const priceUpdatePatch = `*** Begin Patch
*** Update File: source.txt
@@
-price: 5
+price: 7
*** End Patch`;

  it.each([
    { name: "workspace-confined host", workspaceOnly: true },
    { name: "unconfined host", workspaceOnly: false },
  ])("rejects invalid UTF-8 in $name updates without changing bytes", async ({ workspaceOnly }) => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "source.txt");
      const original = Buffer.concat([
        Buffer.from("heading\nprice: 5\n"),
        Buffer.from([0xff, 0xfe]),
      ]);
      await fs.writeFile(filePath, original);

      await expect(applyPatch(priceUpdatePatch, { cwd: dir, workspaceOnly })).rejects.toThrow(
        /not valid UTF-8/,
      );
      await expect(fs.readFile(filePath)).resolves.toEqual(original);
    });
  });

  it("preserves a valid UTF-8 BOM in sandbox updates", async () => {
    const memory = createMemoryPatchSandbox({
      "source.txt": Buffer.from("\uFEFFheading\nprice: 5\n", "utf8"),
    });

    await applyPatch(priceUpdatePatch, memory.options);

    expect(memory.files.get("/sandbox/source.txt")).toBe("\uFEFFheading\nprice: 7\n");
  });

  it.each([
    { name: "workspace-confined host", workspaceOnly: true },
    { name: "unconfined host", workspaceOnly: false },
  ])(
    "keeps existing contents in $name when an add hunk targets them",
    async ({ workspaceOnly }) => {
      await withWorkspaceTempDir(async (dir) => {
        const target = path.join(dir, "notes.txt");
        await fs.writeFile(target, "IMPORTANT USER DATA\nsecond line\n", "utf8");
        const tool = createApplyPatchTool({ cwd: dir, workspaceOnly });
        const patch = `*** Begin Patch
*** Add File: notes.txt
+replacement
*** End Patch`;

        await expect(
          tool.execute("call-add-existing", { input: patch }, undefined),
        ).rejects.toThrow(/Cannot create notes\.txt: the file already exists/);
        expect(await fs.readFile(target, "utf8")).toBe("IMPORTANT USER DATA\nsecond line\n");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses existing symlinks in both host modes without changing their targets",
    async () => {
      for (const workspaceOnly of [true, false]) {
        await withWorkspaceTempDir(async (dir) => {
          const target = path.join(dir, "target.txt");
          const link = path.join(dir, "notes.txt");
          await fs.writeFile(target, "keep me\n", "utf8");
          await fs.symlink("target.txt", link);
          const patch = `*** Begin Patch
*** Add File: notes.txt
+replacement
*** End Patch`;

          await expect(applyPatch(patch, { cwd: dir, workspaceOnly })).rejects.toThrow(
            workspaceOnly ? /symlink/i : /Cannot create notes\.txt: the file already exists/,
          );
          await expect(fs.readFile(target, "utf8")).resolves.toBe("keep me\n");
          await expect(fs.readlink(link)).resolves.toBe("target.txt");
        });
      }
    },
  );

  it("refuses an add hunk when a competing writer creates the target mid-patch", async () => {
    const memory = createMemoryPatchSandbox();
    memory.mkdirp.mockImplementation(async () => {
      memory.files.set("/sandbox/notes.txt", "written by another writer\n");
    });
    const patch = `*** Begin Patch
*** Add File: notes.txt
+replacement
*** End Patch`;

    await expect(applyPatch(patch, memory.options)).rejects.toThrow(
      /Cannot create notes\.txt: the file already exists/,
    );
    expect(memory.files.get("/sandbox/notes.txt")).toBe("written by another writer\n");
    expect(memory.writeFile.mock.calls).toHaveLength(0);
  });

  it("refuses a move hunk when a competing writer creates the destination mid-patch", async () => {
    const memory = createMemoryPatchSandbox({ "source.txt": "foo\nbar\n" });
    memory.mkdirp.mockImplementation(async () => {
      memory.files.set("/sandbox/dest.txt", "written by another writer\n");
    });
    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: dest.txt
@@
 foo
-bar
+baz
*** End Patch`;

    await expect(applyPatch(patch, memory.options)).rejects.toThrow(
      /Cannot create dest\.txt: the file already exists/,
    );
    expect(memory.files.get("/sandbox/dest.txt")).toBe("written by another writer\n");
    expect(memory.files.get("/sandbox/source.txt")).toBe("foo\nbar\n");
  });

  it("allows an add hunk after the same path is deleted in the patch", async () => {
    const memory = createMemoryPatchSandbox({ "notes.txt": "old\n" });
    const patch = `*** Begin Patch
*** Delete File: notes.txt
*** Add File: notes.txt
+new
*** End Patch`;

    const result = await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/notes.txt")).toBe("new\n");
    expect(result.summary.added).toEqual(["notes.txt"]);
  });

  it("fails closed on sandbox adds when atomic create is unavailable", async () => {
    const memory = createMemoryPatchSandbox({}, { supportsExclusiveCreate: false });
    const patch = `*** Begin Patch
*** Add File: notes.txt
+new
*** End Patch`;

    await expect(applyPatch(patch, memory.options)).rejects.toThrow(
      /does not support atomic file creation/,
    );
    expect(memory.files.has("/sandbox/notes.txt")).toBe(false);
  });

  it("updates and moves a file", async () => {
    const memory = createMemoryPatchSandbox({
      "source.txt": "foo\nbar\n",
    });
    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: dest.txt
@@
 foo
-bar
+baz
*** End Patch`;

    const result = await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/dest.txt")).toBe("foo\nbaz\n");
    expect(memory.files.has("/sandbox/source.txt")).toBe(false);
    expect(result.summary.modified).toEqual(["dest.txt"]);
  });

  it.each(["./source.txt", "/sandbox/./source.txt", "/sandbox//source.txt"])(
    "updates in place when legacy bridge move target %s names the source file",
    async (movePath) => {
      const memory = createMemoryPatchSandbox({
        "source.txt": "foo\nbar\n",
      });
      // The public bridge contract permits resolved container paths with dot
      // segments. Its filesystem still treats these spellings as one file.
      memory.bridge.resolvePath = ({ filePath }) => ({
        relativePath: filePath,
        containerPath: path.posix.isAbsolute(filePath) ? filePath : `/sandbox/${filePath}`,
      });
      const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: ${movePath}
@@
 foo
-bar
+baz
*** End Patch`;

      const result = await applyPatch(patch, memory.options);

      expect(memory.files.get("/sandbox/source.txt")).toBe("foo\nbaz\n");
      expect(memory.files.size).toBe(1);
      expect(memory.createFileExclusive).not.toHaveBeenCalled();
      expect(memory.remove).not.toHaveBeenCalled();
      expect(result.summary.modified).toEqual(["source.txt"]);
    },
  );

  it.each([
    { containerRoot: "C:\\work", movePath: "C:\\work\\.\\source.txt" },
    { containerRoot: "C:\\work", movePath: "c:\\WORK\\SOURCE.txt" },
    { containerRoot: "\\\\server\\share", movePath: "\\\\SERVER\\share\\.\\source.txt" },
  ])(
    "updates and no-ops native Windows legacy same-file moves to $movePath",
    async ({ containerRoot, movePath }) => {
      const memory = createMemoryPatchSandbox({ "source.txt": "before\n" }, { containerRoot });
      memory.bridge.resolvePath = ({ filePath }) => ({
        relativePath: path.win32.isAbsolute(filePath)
          ? path.win32.relative(containerRoot, filePath)
          : filePath,
        containerPath: path.win32.isAbsolute(filePath) ? filePath : `${containerRoot}\\${filePath}`,
      });
      const move = (before: string, after: string) =>
        [
          "*** Begin Patch",
          "*** Update File: source.txt",
          `*** Move to: ${movePath}`,
          "@@",
          `-${before}`,
          `+${after}`,
          "*** End Patch",
        ].join("\n");
      await expect(applyPatch(move("before", "after"), memory.options)).resolves.toMatchObject({
        summary: { modified: ["source.txt"] },
      });
      await expect(applyPatch(move("after", "after"), memory.options)).resolves.toMatchObject({
        noOp: true,
      });
      expect([...memory.files.values()]).toEqual(["after\n"]);
      expect(memory.writeFile).toHaveBeenCalledTimes(1);
      expect(memory.createFileExclusive).not.toHaveBeenCalled();
      expect(memory.remove).not.toHaveBeenCalled();
    },
  );

  it.each([
    { first: "C:\\work\\source.txt", second: "\\\\?\\c:\\WORK\\.\\source.txt", same: true },
    {
      first: "\\\\server\\share\\source.txt",
      second: "\\\\?\\UNC\\SERVER\\share\\.\\source.txt",
      same: true,
    },
    { first: "/workspace/a\\b", second: "/workspace/a/b", same: false },
    { first: "/workspace/C:\\name", second: "/workspace/C:/name", same: false },
  ])("compares legacy queue identity for $first and $second", async ({ first, second, same }) => {
    const { bridge } = createMemoryPatchSandbox();
    bridge.resolvePath = ({ filePath }) => ({ containerPath: filePath, relativePath: filePath });
    const key = (filePath: string) =>
      resolveSandboxFileMutationQueueKey({ bridge, root: "/queue", filePath });
    expect((await key(first)) === (await key(second))).toBe(same);
  });

  it("normalizes supported punctuation while matching update hunks", async () => {
    const cases = [
      ["a\u2010\u2011\u2012\u2013\u2014\u2015\u2212b", "a-------b"],
      ["a\u2018\u2019\u201A\u201Bb", "a''''b"],
      ["a\u201C\u201D\u201E\u201Fb", 'a""""b'],
      [
        "a\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000b",
        "a             b",
      ],
    ] as const;

    for (const [sourceLine, patchLine] of cases) {
      const memory = createMemoryPatchSandbox({
        "source.txt": `${sourceLine}\n`,
      });
      const patch = `*** Begin Patch
*** Update File: source.txt
@@
-${patchLine}
+updated
*** End Patch`;

      await applyPatch(patch, memory.options);

      expect(memory.files.get("/sandbox/source.txt")).toBe("updated\n");
    }
  });

  it("rejects path traversal outside cwd by default", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(
        path.dirname(dir),
        `escaped-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
      );
      const relativeEscape = path.relative(dir, escapedPath);

      try {
        await expectOutsideWriteRejected({
          dir,
          patchTargetPath: relativeEscape,
          outsidePath: escapedPath,
        });
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("rejects broken final symlink targets outside cwd by default", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withWorkspaceTempDir(async (dir) => {
      const outsideDir = path.join(path.dirname(dir), `outside-broken-link-${Date.now()}`);
      const outsideFile = path.join(outsideDir, "owned.txt");
      const linkPath = path.join(dir, "jump");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideFile, linkPath);

      const patch = `*** Begin Patch
*** Add File: jump
+pwned
*** End Patch`;

      try {
        await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
          /Symlink escapes sandbox root/,
        );
        await expectMissingPath(fs.readFile(outsideFile, "utf8"));
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects symlinks within cwd by default", async () => {
    // File symlinks require SeCreateSymbolicLinkPrivilege on Windows.
    if (process.platform === "win32") {
      return;
    }
    await withTempDir(async (dir) => {
      const target = path.join(dir, "target.txt");
      const linkPath = path.join(dir, "link.txt");
      await fs.writeFile(target, "initial\n", "utf8");
      await fs.symlink(target, linkPath);

      const patch = `*** Begin Patch
*** Update File: link.txt
@@
-initial
+updated
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
        // fs-safe 0.5.2 reports the symlink rejection through the boundary-read
        // validation path ("unsafe path") instead of a symlink-specific message.
        /path is not a regular file under root|symlink open blocked|unsafe path/i,
      );
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("initial\n");
    });
  });

  it("rejects delete path traversal via symlink directories by default", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = path.join(path.dirname(dir), `outside-dir-${process.pid}-${Date.now()}`);
      const outsideFile = path.join(outsideDir, "victim.txt");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "victim\n", "utf8");

      const linkDir = path.join(dir, "linkdir");
      // Use 'junction' on Windows — junctions target directories without
      // requiring SeCreateSymbolicLinkPrivilege.
      await fs.symlink(outsideDir, linkDir, process.platform === "win32" ? "junction" : undefined);

      const patch = `*** Begin Patch
*** Delete File: linkdir/victim.txt
*** End Patch`;

      try {
        await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
          /Symlink escapes sandbox root/,
        );
        const stillThere = await fs.readFile(outsideFile, "utf8");
        expect(stillThere).toBe("victim\n");
      } finally {
        await fs.rm(outsideFile, { force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("allows path traversal when workspaceOnly is explicitly disabled", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(
        path.dirname(dir),
        `escaped-allow-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
      );
      const relativeEscape = path.relative(dir, escapedPath);

      const patch = `*** Begin Patch
*** Add File: ${relativeEscape}
+escaped
*** End Patch`;

      try {
        const result = await applyPatch(patch, { cwd: dir, workspaceOnly: false });
        expect(result.summary.added.length).toBe(1);
        const contents = await fs.readFile(escapedPath, "utf8");
        expect(contents).toBe("escaped\n");
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("allows deleting a symlink itself even if it points outside cwd", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = await fs.mkdtemp(path.join(path.dirname(dir), "openclaw-patch-outside-"));
      try {
        const outsideTarget = path.join(outsideDir, "target.txt");
        await fs.writeFile(outsideTarget, "keep\n", "utf8");

        const linkDir = path.join(dir, "link");
        // Use 'junction' on Windows — junctions target directories without
        // requiring SeCreateSymbolicLinkPrivilege.
        await fs.symlink(
          outsideDir,
          linkDir,
          process.platform === "win32" ? "junction" : undefined,
        );

        const patch = `*** Begin Patch
*** Delete File: link
*** End Patch`;

        const result = await applyPatch(patch, { cwd: dir });
        expect(result.summary.deleted).toEqual(["link"]);
        await expectMissingPath(fs.lstat(linkDir));
        const outsideContents = await fs.readFile(outsideTarget, "utf8");
        expect(outsideContents).toBe("keep\n");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects move targets whose parent path is a symlink outside cwd", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir(async (dir) => {
      const outsideDir = await fs.mkdtemp(path.join(path.dirname(dir), "openclaw-patch-outside-"));
      try {
        const sourcePath = path.join(dir, "source.txt");
        const outsideTarget = path.join(outsideDir, "moved.txt");
        const linkDir = path.join(dir, "link");
        await fs.writeFile(sourcePath, "before\n", "utf8");
        await fs.symlink(outsideDir, linkDir);

        const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: link/moved.txt
@@
-before
+after
*** End Patch`;

        await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
          /symlink escapes sandbox root/i,
        );
        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("before\n");
        await expectMissingPath(fs.readFile(outsideTarget, "utf8"));
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not delete out-of-root files when a checked directory is rebound before remove",
    async () => {
      await withTempDir(async (dir) => {
        const inside = path.join(dir, "inside");
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-outside-"));
        const slot = path.join(dir, "slot");
        await fs.mkdir(inside, { recursive: true });
        await fs.writeFile(path.join(inside, "target.txt"), "inside\n", "utf8");
        const outsideTarget = path.join(outside, "target.txt");
        await fs.writeFile(outsideTarget, "outside\n", "utf8");
        await createRebindableDirectoryAlias({
          aliasPath: slot,
          targetPath: inside,
        });

        const patch = `*** Begin Patch
*** Delete File: slot/target.txt
*** End Patch`;

        try {
          await withRealpathSymlinkRebindRace({
            realpathApi: "native-sync",
            shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot")),
            symlinkPath: slot,
            symlinkTarget: outside,
            timing: "before-realpath",
            run: async () => {
              await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
                /symlink escapes sandbox root|under root|not found/i,
              );
            },
          });
          await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside\n");
        } finally {
          await fs.rm(outside, { recursive: true, force: true });
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not create out-of-root directories when a checked directory is rebound before mkdir",
    async () => {
      await withTempDir(async (dir) => {
        const inside = path.join(dir, "inside");
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-outside-"));
        const slot = path.join(dir, "slot");
        await fs.mkdir(inside, { recursive: true });
        await createRebindableDirectoryAlias({
          aliasPath: slot,
          targetPath: inside,
        });

        const patch = `*** Begin Patch
*** Add File: slot/nested/deep/file.txt
+safe
*** End Patch`;

        try {
          await withRealpathSymlinkRebindRace({
            shouldFlip: (realpathInput) =>
              realpathInput.endsWith(path.join("slot", "nested", "deep", "file.txt")),
            symlinkPath: slot,
            symlinkTarget: outside,
            timing: "before-realpath",
            run: async () => {
              await expect(applyPatch(patch, { cwd: dir })).rejects.toMatchObject({
                name: "FsSafeError",
                code: "symlink",
              });
            },
          });
          await expectMissingPath(fs.stat(path.join(outside, "nested")));
        } finally {
          await fs.rm(outside, { recursive: true, force: true });
        }
      });
    },
  );

  it.each(["legacy", "empty", "miss", "mapped"] as const)(
    "honors %s path mappings before patch mutation",
    async (mode) => {
      await withTempDir(async (root) => {
        const mapping = { hostRoot: root, containerRoot: "C:\\NativeWorkspace" };
        const mappings = mode === "legacy" ? undefined : mode === "empty" ? [] : [mapping];
        const runtimeRoot = mode === "miss" ? "C:\\Other" : mapping.containerRoot;
        const bridge = createSandboxFsBridgeFromResolver((filePath) => {
          const relativePath = path.win32.isAbsolute(filePath)
            ? path.win32.relative(runtimeRoot, filePath)
            : filePath;
          return {
            hostPath: path.resolve(root, relativePath),
            relativePath,
            containerPath: path.win32.join(runtimeRoot, relativePath),
          };
        }, mappings);
        const create = vi.spyOn(bridge, "createFileExclusive");
        const tool = createApplyPatchTool({
          cwd: root,
          sandbox: { root, bridge, workspaceMounts: mappings },
        });
        if (mode === "empty" || mode === "miss") {
          await expect(
            tool.execute("denied", { input: buildAddFilePatch("new.txt") }),
          ).rejects.toThrow("Path escapes sandbox root");
          expect(create).not.toHaveBeenCalled();
          expect(await fs.readdir(root)).toEqual([]);
          return;
        }
        await tool.execute("admitted", { input: buildAddFilePatch("new.txt") });
        expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("escaped\n");
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({ filePath: "C:\\NativeWorkspace\\new.txt" }),
        );
        await expect(
          tool.execute("outside", { input: buildAddFilePatch("../outside.txt") }),
        ).rejects.toThrow(/Path escapes sandbox root/);
      });
    },
  );
});

describe("applyPatch through directory aliases", () => {
  it.runIf(process.platform !== "win32").each([
    { name: "direct root", aliasedRoot: false, selfMove: false },
    { name: "canonical input under an aliased root", aliasedRoot: true, selfMove: false },
    { name: "same-file move", aliasedRoot: false, selfMove: true },
  ])(
    "updates and removes contained directory aliases through $name",
    async ({ aliasedRoot, selfMove }) => {
      await withTempDir(async (dir) => {
        const realDir = path.join(dir, "real");
        await fs.mkdir(realDir, { recursive: true });
        await fs.writeFile(path.join(realDir, "note.txt"), "initial\n", "utf8");
        await fs.symlink(realDir, path.join(dir, "alias"), "dir");
        const cwd = aliasedRoot ? path.join(dir, "workspace-alias") : dir;
        if (aliasedRoot) {
          await fs.symlink(dir, cwd, "dir");
        }
        const target = aliasedRoot ? path.join(dir, "alias", "note.txt") : "alias/note.txt";

        const patch = `*** Begin Patch
*** Update File: ${selfMove ? "real/note.txt\n*** Move to: alias/note.txt" : target}
@@
-initial
+updated
*** End Patch`;

        await applyPatch(patch, { cwd });
        await expect(fs.readFile(path.join(realDir, "note.txt"), "utf8")).resolves.toBe(
          "updated\n",
        );
        await applyPatch(`*** Begin Patch\n*** Delete File: ${target}\n*** End Patch`, { cwd });
        await expect(fs.readdir(realDir)).resolves.toEqual([]);
        expect((await fs.lstat(path.join(dir, "alias"))).isSymbolicLink()).toBe(true);
      });
    },
  );

  it.runIf(process.platform !== "win32").each(["add", "move"] as const)(
    "rejects %s destinations through contained directory aliases",
    async (operation) => {
      await withTempDir(async (dir) => {
        const realDir = path.join(dir, "real");
        await fs.mkdir(realDir);
        await fs.symlink(realDir, path.join(dir, "alias"), "dir");
        await fs.writeFile(path.join(dir, "source.txt"), "original\n");
        const input =
          operation === "add"
            ? "*** Begin Patch\n*** Add File: alias/new.txt\n+new\n*** End Patch"
            : "*** Begin Patch\n*** Update File: source.txt\n*** Move to: alias/new.txt\n@@\n-original\n+new\n*** End Patch";

        await expect(applyPatch(input, { cwd: dir })).rejects.toMatchObject({
          name: "FsSafeError",
          code: "symlink",
        });

        await expect(fs.readdir(realDir)).resolves.toEqual([]);
        await expect(fs.readFile(path.join(dir, "source.txt"), "utf8")).resolves.toBe("original\n");
      });
    },
  );

  it("creates, updates, and deletes files in a literal tilde directory", async () => {
    await withTempDir(async (dir) => {
      await applyPatch("*** Begin Patch\n*** Add File: ./~/note.txt\n+initial\n*** End Patch", {
        cwd: dir,
      });
      await applyPatch(
        "*** Begin Patch\n*** Update File: ./~/note.txt\n@@\n-initial\n+updated\n*** End Patch",
        { cwd: dir },
      );

      await expect(fs.readFile(path.join(dir, "~", "note.txt"), "utf8")).resolves.toBe("updated\n");
      await applyPatch("*** Begin Patch\n*** Delete File: ./~/note.txt\n*** End Patch", {
        cwd: dir,
      });
      await expect(fs.readdir(path.join(dir, "~"))).resolves.toEqual([]);
    });
  });
});

describe("apply_patch unrestricted host writes", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createHostFile(content: string) {
    const tempDir = tempDirs.make("openclaw-patch-host-write-");
    const filePath = path.join(tempDir, "important.txt");
    await fs.writeFile(filePath, content);
    return filePath;
  }

  function failPrefixWrites(filePath: string, originalByteLength: number) {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realWrite = handle.write.bind(handle);
        let failed = false;
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          if (!failed && position < originalByteLength) {
            failed = true;
            await realWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          return realWrite(buffer, offset, length, position);
        }) as typeof handle.write;
      }
      return handle;
    });
  }

  function failExtensionWrites(filePath: string, originalByteLength: number) {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realWrite = handle.write.bind(handle);
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const result = await realWrite(buffer, offset, length, position);
          if (position >= originalByteLength) {
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          return result;
        }) as typeof handle.write;
      }
      return handle;
    });
  }

  function buildUpdatePatch(filePath: string): string {
    return `*** Begin Patch
*** Update File: ${filePath}
@@
-original
+replacement
*** End Patch`;
  }

  it("keeps the original host file when an update hunk fails partway through the write", async () => {
    const originalContent = `original\n${"important content\n".repeat(64)}`;
    const filePath = await createHostFile(originalContent);
    failPrefixWrites(filePath, Buffer.byteLength(originalContent));

    await expect(
      applyPatch(buildUpdatePatch(filePath), { cwd: path.dirname(filePath), workspaceOnly: false }),
    ).rejects.toThrow("disk full");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(["important.txt"]);
  });

  it("keeps the original host file when an update hunk cannot extend the file", async () => {
    const originalContent = "original\n";
    const filePath = await createHostFile(originalContent);
    failExtensionWrites(filePath, Buffer.byteLength(originalContent));

    await expect(
      applyPatch(buildUpdatePatch(filePath), { cwd: path.dirname(filePath), workspaceOnly: false }),
    ).rejects.toThrow("disk full");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(["important.txt"]);
  });

  it.runIf(process.platform !== "win32")("applies host update hunks in place", async () => {
    const filePath = await createHostFile("original\n");
    await fs.chmod(filePath, 0o640);
    const before = await fs.stat(filePath);

    const result = await applyPatch(buildUpdatePatch(filePath), {
      cwd: path.dirname(filePath),
      workspaceOnly: false,
    });

    expect(result.summary.modified).toEqual(["important.txt"]);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement\n");
    const after = await fs.stat(filePath);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);
  });
});

describe("apply_patch mutation authority", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    __setFsSafeTestHooksForTest();
  });

  it.each(["create", "remove"] as const)(
    "rechecks patch authority after %s preparation",
    async (operation) => {
      const root = await fs.realpath(tempDirs.make("openclaw-patch-authority-"));
      const existing = path.join(root, "existing.txt");
      await fs.writeFile(existing, "original\n");
      const target = operation === "create" ? path.join(root, "nested", "new.txt") : existing;
      let current = true;
      let prepared = false;
      const revoke = async () => {
        await Promise.resolve();
        current = false;
        prepared = true;
      };
      __setFsSafeTestHooksForTest({
        beforePinnedWriteParentAdmission: async (targetPath) => {
          if (operation === "create" && targetPath === target) {
            await revoke();
          }
        },
        beforeRootFallbackMutation: async (kind, targetPath) => {
          if (kind === operation && targetPath === target) {
            await revoke();
          }
        },
      });

      const tool = createApplyPatchTool({ cwd: root });
      const input =
        operation === "create"
          ? "*** Begin Patch\n*** Add File: nested/new.txt\n+new\n*** End Patch"
          : "*** Begin Patch\n*** Delete File: existing.txt\n*** End Patch";
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:patch-authority",
          receiptAuthority: () => current,
        },
        () => tool.execute("patch-authority", { input }),
      );

      await expect(pending).rejects.toThrow("authority is no longer active");
      expect(prepared).toBe(true);
      await expect(fs.readFile(existing, "utf8")).resolves.toBe("original\n");
      await expect(fs.readdir(root)).resolves.toEqual(["existing.txt"]);
    },
  );
});
