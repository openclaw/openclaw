/**
 * Tests that apply_patch rejects predictable update failures before any hunk
 * mutates the workspace, including hunks that replace links earlier hunks remove.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  // Sandbox checks compare canonical paths; macOS tmpdir is itself a symlink.
  return fn(await fs.realpath(tempDirs.make("openclaw-patch-preflight-")));
}

describe("applyPatch preflight", () => {
  it.each([
    {
      name: "a delete before an update of a missing file",
      patch: `*** Begin Patch
*** Delete File: important.txt
*** Update File: missing.txt
@@
-old
+new
*** End Patch`,
      error: /Failed to read file to update .*missing\.txt/,
    },
    {
      name: "an add and an update before a context mismatch",
      patch: `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: important.txt
@@
-irreplaceable
+rewritten
*** Update File: important.txt
@@
-not in the file
+changed
*** End Patch`,
      error: /Failed to find expected lines in .*important\.txt/,
    },
  ])("leaves the workspace unchanged when $name rejects", async ({ patch, error }) => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "important.txt"), "irreplaceable\n");

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(error);

      expect(await fs.readdir(dir)).toEqual(["important.txt"]);
      expect(await fs.readFile(path.join(dir, "important.txt"), "utf8")).toBe("irreplaceable\n");
    });
  });

  it("updates files that earlier hunks in the same patch add or change", async () => {
    const memory = createMemoryPatchSandbox({ "notes.txt": "one\n" });
    const patch = `*** Begin Patch
*** Add File: created.txt
+draft
*** Update File: created.txt
@@
-draft
+final
*** Update File: notes.txt
@@
-one
+two
*** Update File: notes.txt
*** Move to: moved.txt
@@
-two
+three
*** End Patch`;

    await applyPatch(patch, memory.options);

    expect(Object.fromEntries(memory.files)).toEqual({
      "/sandbox/created.txt": "final\n",
      "/sandbox/moved.txt": "three\n",
    });
  });

  it.runIf(process.platform !== "win32")(
    "replaces an outside symlink that the same patch deletes first",
    async () => {
      await withTempDir(async (dir) => {
        const outsideDir = await fs.realpath(tempDirs.make("openclaw-patch-outside-"));
        const outsideTarget = path.join(outsideDir, "target.txt");
        await fs.writeFile(outsideTarget, "keep\n", "utf8");
        const link = path.join(dir, "link.txt");
        await fs.symlink(outsideTarget, link);
        const input = `*** Begin Patch
*** Delete File: link.txt
*** Add File: link.txt
+draft
*** Update File: link.txt
@@
-draft
+final
*** End Patch`;

        const result = await createApplyPatchTool({ cwd: dir }).execute(
          "call-replace-link",
          { input },
          undefined,
        );

        expect(result.details.summary).toEqual({
          added: ["link.txt"],
          modified: ["link.txt"],
          deleted: ["link.txt"],
        });
        expect((await fs.lstat(link)).isFile()).toBe(true);
        await expect(fs.readFile(link, "utf8")).resolves.toBe("final\n");
        await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("keep\n");
      });
    },
  );

  it.runIf(process.platform !== "win32").each([
    {
      name: "a mismatched update of the target",
      hunks: `*** Update File: target.txt
@@
-not in the file
+changed`,
      error: /Failed to find expected lines in .*target\.txt/,
    },
    {
      name: "a move of the target onto the link and a later update of the target",
      hunks: `*** Update File: target.txt
*** Move to: link.txt
@@
-keep
+moved
*** Update File: target.txt
@@
-keep
+changed`,
      error: /Failed to read file to update .*target\.txt/,
    },
  ])("keeps a deleted in-workspace symlink when $name rejects", async ({ hunks, error }) => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "target.txt");
      const link = path.join(dir, "link.txt");
      await fs.writeFile(target, "keep\n", "utf8");
      await fs.symlink(target, link);

      await expect(
        createApplyPatchTool({ cwd: dir }).execute(
          "call-unlink-then-reject",
          { input: `*** Begin Patch\n*** Delete File: link.txt\n${hunks}\n*** End Patch` },
          undefined,
        ),
      ).rejects.toThrow(error);

      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      await expect(fs.readFile(target, "utf8")).resolves.toBe("keep\n");
    });
  });

  it.runIf(process.platform !== "win32").each([
    {
      name: "a replaced link apart from its old target",
      hunks: `*** Add File: link.txt
+draft
*** Update File: target.txt
@@
-keep
+kept
*** Update File: link.txt
@@
-draft
+final`,
      files: { "link.txt": "final\n", "target.txt": "kept\n" },
    },
    {
      name: "a move of the old target onto the link path",
      hunks: `*** Update File: target.txt
*** Move to: link.txt
@@
-keep
+moved`,
      files: { "link.txt": "moved\n" },
    },
  ])("stages $name after deleting an in-workspace symlink", async ({ hunks, files }) => {
    await withTempDir(async (dir) => {
      const link = path.join(dir, "link.txt");
      await fs.writeFile(path.join(dir, "target.txt"), "keep\n", "utf8");
      await fs.symlink(path.join(dir, "target.txt"), link);

      await createApplyPatchTool({ cwd: dir }).execute(
        "call-replace-link",
        { input: `*** Begin Patch\n*** Delete File: link.txt\n${hunks}\n*** End Patch` },
        undefined,
      );

      expect((await fs.lstat(link)).isFile()).toBe(true);
      const names = (await fs.readdir(dir)).toSorted();
      const contents = await Promise.all(names.map((name) => fs.readFile(path.join(dir, name))));
      expect(Object.fromEntries(names.map((name, i) => [name, contents[i]?.toString()]))).toEqual(
        files,
      );
    });
  });

  it.each([
    {
      name: "re-creates a hardlinked path",
      hunks: "*** Add File: alias.txt\n+new",
      files: { "alias.txt": "new\n", "original.txt": "keep\n" },
    },
    {
      name: "updates the other name of a hardlink",
      hunks: "*** Update File: original.txt\n@@\n-keep\n+changed",
      files: { "original.txt": "changed\n" },
    },
  ])("$name after the same patch deletes one name", async ({ hunks, files }) => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "original.txt"), "keep\n", "utf8");
      await fs.link(path.join(dir, "original.txt"), path.join(dir, "alias.txt"));

      await createApplyPatchTool({ cwd: dir }).execute(
        "call-replace-hardlink",
        { input: `*** Begin Patch\n*** Delete File: alias.txt\n${hunks}\n*** End Patch` },
        undefined,
      );

      const names = (await fs.readdir(dir)).toSorted();
      const contents = await Promise.all(names.map((name) => fs.readFile(path.join(dir, name))));
      expect(Object.fromEntries(names.map((name, i) => [name, contents[i]?.toString()]))).toEqual(
        files,
      );
    });
  });

  it("replaces a file with a directory that the same patch deletes first", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "x"), "file\n", "utf8");

      await applyPatch(
        "*** Begin Patch\n*** Delete File: x\n*** Add File: x/y.txt\n+new\n*** End Patch",
        {
          cwd: dir,
        },
      );

      await expect(fs.readFile(path.join(dir, "x", "y.txt"), "utf8")).resolves.toBe("new\n");
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects an update of a moved symlink path before moving it",
    async () => {
      await withTempDir(async (dir) => {
        const link = path.join(dir, "link.txt");
        await fs.writeFile(path.join(dir, "target.txt"), "keep\n", "utf8");
        await fs.symlink(path.join(dir, "target.txt"), link);
        const input = `*** Begin Patch
*** Update File: link.txt
*** Move to: moved.txt
@@
-keep
+moved
*** Update File: link.txt
@@
-keep
+changed
*** End Patch`;

        await expect(applyPatch(input, { cwd: dir, workspaceOnly: false })).rejects.toThrow(
          /Failed to read file to update .*link\.txt/,
        );

        expect((await fs.readdir(dir)).toSorted()).toEqual(["link.txt", "target.txt"]);
        await expect(fs.readFile(link, "utf8")).resolves.toBe("keep\n");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "replaces an outside directory symlink that the same patch deletes first",
    async () => {
      await withTempDir(async (dir) => {
        const outsideDir = await fs.realpath(tempDirs.make("openclaw-patch-outside-"));
        await fs.writeFile(path.join(outsideDir, "x.txt"), "keep\n", "utf8");
        await fs.symlink(outsideDir, path.join(dir, "d"));

        await createApplyPatchTool({ cwd: dir }).execute(
          "call-replace-dir-link",
          {
            input: `*** Begin Patch
*** Delete File: d
*** Add File: d/x.txt
+new
*** Add File: d/..cache
+cache
*** Delete File: d/x.txt
*** End Patch`,
          },
          undefined,
        );

        expect((await fs.lstat(path.join(dir, "d"))).isDirectory()).toBe(true);
        expect(await fs.readdir(path.join(dir, "d"))).toEqual(["..cache"]);
        await expect(fs.readFile(path.join(outsideDir, "x.txt"), "utf8")).resolves.toBe("keep\n");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an outside symlink update before an unrelated delete runs",
    async () => {
      await withTempDir(async (dir) => {
        const outsideDir = await fs.realpath(tempDirs.make("openclaw-patch-outside-"));
        await fs.writeFile(path.join(outsideDir, "target.txt"), "keep\n", "utf8");
        await fs.symlink(path.join(outsideDir, "target.txt"), path.join(dir, "link.txt"));
        await fs.writeFile(path.join(dir, "unrelated.txt"), "keep\n", "utf8");
        const input = `*** Begin Patch
*** Delete File: unrelated.txt
*** Update File: link.txt
@@
-keep
+changed
*** End Patch`;

        await expect(applyPatch(input, { cwd: dir })).rejects.toThrow(/sandbox root/);

        await expect(fs.readFile(path.join(dir, "unrelated.txt"), "utf8")).resolves.toBe("keep\n");
      });
    },
  );
});
