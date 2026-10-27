import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// The temp root's volume decides whether two spellings name one entry (APFS and NTFS by default).
const caseInsensitiveTemp = existsSync(os.tmpdir().toUpperCase());

// The tracker canonicalizes the system temp root before creating directories.
let dir: string;
beforeEach(() => {
  dir = tempDirs.make("openclaw-patch-preflight-");
});

const patch = (...hunks: string[]) => ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n");
const update = (file: string, before: string, after: string) =>
  `*** Update File: ${file}\n@@\n-${before}\n+${after}`;
const execute = (root: string, input: string, workspaceOnly = true) =>
  createApplyPatchTool({ cwd: root, workspaceOnly }).execute("preflight", { input }, undefined);

async function symlink(root: string, targetDir = root) {
  const target = path.join(targetDir, "target.txt");
  const link = path.join(root, "link.txt");
  await fs.writeFile(target, "keep\n", "utf8");
  await fs.symlink(target, link);
  return { target, link };
}

async function hardlink(root: string, content = "keep\n") {
  await fs.writeFile(path.join(root, "original.txt"), content, "utf8");
  await fs.link(path.join(root, "original.txt"), path.join(root, "alias.txt"));
}

async function expectFiles(root: string, files: Record<string, string>) {
  const names = (await fs.readdir(root)).toSorted();
  const contents = await Promise.all(
    names.map((name) => fs.readFile(path.join(root, name), "utf8")),
  );
  expect(Object.fromEntries(names.map((name, i) => [name, contents[i]]))).toEqual(files);
}

describe("applyPatch preflight", () => {
  it.each([
    [
      "missing file",
      patch("*** Delete File: important.txt", update("missing.txt", "old", "new")),
      /Failed to read file to update .*missing\.txt/,
    ],
    [
      "context mismatch",
      patch(
        "*** Add File: created.txt\n+created",
        update("important.txt", "irreplaceable", "rewritten"),
        update("important.txt", "not in the file", "changed"),
      ),
      /Failed to find expected lines in .*important\.txt/,
    ],
  ] as const)("leaves the workspace unchanged on %s", async (_name, input, error) => {
    await fs.writeFile(path.join(dir, "important.txt"), "irreplaceable\n");

    await expect(applyPatch(input, { cwd: dir })).rejects.toThrow(error);

    await expectFiles(dir, { "important.txt": "irreplaceable\n" });
  });

  it("updates files that earlier hunks in the same patch add or change", async () => {
    const memory = createMemoryPatchSandbox({ "notes.txt": "one\n" });
    await applyPatch(
      patch(
        "*** Add File: created.txt\n+draft",
        update("created.txt", "draft", "final"),
        update("notes.txt", "one", "two"),
        "*** Update File: notes.txt\n*** Move to: moved.txt\n@@\n-two\n+three",
      ),
      memory.options,
    );

    expect(Object.fromEntries(memory.files)).toEqual({
      "/sandbox/created.txt": "final\n",
      "/sandbox/moved.txt": "three\n",
    });
  });

  it.runIf(process.platform !== "win32")(
    "replaces an outside symlink that the same patch deletes first",
    async () => {
      const outsideDir = await fs.realpath(tempDirs.make("openclaw-patch-outside-"));
      const { target: outsideTarget, link } = await symlink(dir, outsideDir);
      const result = await execute(
        dir,
        patch(
          "*** Delete File: link.txt",
          "*** Add File: link.txt\n+draft",
          update("link.txt", "draft", "final"),
        ),
      );

      expect(result.details.summary).toEqual({
        added: ["link.txt"],
        modified: ["link.txt"],
        deleted: ["link.txt"],
      });
      expect((await fs.lstat(link)).isFile()).toBe(true);
      await expect(fs.readFile(link, "utf8")).resolves.toBe("final\n");
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("keep\n");
    },
  );

  // Linux link(2) hardlinks the symlink entry itself instead of the file it names.
  it.runIf(process.platform === "linux")(
    "updates the other name of a hardlinked symlink after deleting one name",
    async () => {
      await fs.writeFile(path.join(dir, "target.txt"), "old\n", "utf8");
      await fs.symlink(path.join(dir, "target.txt"), path.join(dir, "a"));
      await fs.link(path.join(dir, "a"), path.join(dir, "b"));

      await applyPatch(
        "*** Begin Patch\n*** Delete File: a\n*** Update File: b\n@@\n-old\n+new\n*** End Patch",
        { cwd: dir, workspaceOnly: false },
      );

      expect((await fs.readdir(dir)).toSorted()).toEqual(["b", "target.txt"]);
      await expect(fs.readFile(path.join(dir, "target.txt"), "utf8")).resolves.toBe("new\n");
    },
  );

  it.runIf(process.platform !== "win32" && caseInsensitiveTemp).each([
    {
      name: "a file in different casing",
      hunks: "*** Delete File: link.txt\n*** Add File: LINK.txt\n+new",
      created: "LINK.txt",
    },
    {
      name: "a file under a directory link in different casing",
      hunks: "*** Delete File: d\n*** Add File: D/x.txt\n+new",
      created: "D/x.txt",
    },
  ])(
    "replaces an outside symlink with $name on a case-insensitive volume",
    async ({ hunks, created }) => {
      const outsideDir = await fs.realpath(tempDirs.make("openclaw-patch-outside-"));
      await symlink(dir, outsideDir);
      await fs.symlink(outsideDir, path.join(dir, "d"));

      await execute(dir, patch(hunks));

      await expect(fs.readFile(path.join(dir, created), "utf8")).resolves.toBe("new\n");
      expect(await fs.readdir(outsideDir)).toEqual(["target.txt"]);
      await expect(fs.readFile(path.join(outsideDir, "target.txt"), "utf8")).resolves.toBe(
        "keep\n",
      );
    },
  );

  it.runIf(process.platform !== "win32").each([
    {
      name: "a mismatched update of the target",
      hunks: update("target.txt", "not in the file", "changed"),
      error: /Failed to find expected lines in .*target\.txt/,
    },
    {
      name: "a move of the target onto the link and a later update of the target",
      hunks: [
        "*** Update File: target.txt\n*** Move to: link.txt\n@@\n-keep\n+moved",
        update("target.txt", "keep", "changed"),
      ].join("\n"),
      error: /Failed to read file to update .*target\.txt/,
    },
  ])("keeps a deleted in-workspace symlink when $name rejects", async ({ hunks, error }) => {
    const { target, link } = await symlink(dir);

    await expect(execute(dir, patch("*** Delete File: link.txt", hunks))).rejects.toThrow(error);

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("keep\n");
  });

  it.runIf(process.platform !== "win32").each([
    [
      "replacement apart from old target",
      [
        "*** Add File: link.txt\n+draft",
        update("target.txt", "keep", "kept"),
        update("link.txt", "draft", "final"),
      ].join("\n"),
      { "link.txt": "final\n", "target.txt": "kept\n" },
    ],
    [
      "move of old target",
      "*** Update File: target.txt\n*** Move to: link.txt\n@@\n-keep\n+moved",
      { "link.txt": "moved\n" },
    ],
  ] as const)("stages %s after deleting a symlink", async (_name, hunks, files) => {
    const { link } = await symlink(dir);
    await execute(dir, patch("*** Delete File: link.txt", hunks));

    expect((await fs.lstat(link)).isFile()).toBe(true);
    await expectFiles(dir, files);
  });

  it.each([
    [
      "re-creates path",
      "*** Add File: alias.txt\n+new",
      { "alias.txt": "new\n", "original.txt": "keep\n" },
    ],
    [
      "updates other name",
      update("original.txt", "keep", "changed"),
      { "original.txt": "changed\n" },
    ],
  ] as const)("%s after deleting a hardlink name", async (_name, hunks, files) => {
    await hardlink(dir);
    await execute(dir, patch("*** Delete File: alias.txt", hunks));
    await expectFiles(dir, files);
  });

  it.each([
    [
      "updates other name",
      update("alias.txt", "two", "three"),
      "",
      { "alias.txt": "three\n", "original.txt": "three\n" },
    ],
    [
      "deletes first name",
      "*** Delete File: original.txt\n*** Update File: alias.txt\n@@\n-two\n+three",
      "",
      { "alias.txt": "three\n" },
    ],
    [
      "moves first name",
      update("alias.txt", "one", "kept"),
      "*** Move to: moved.txt\n",
      { "alias.txt": "kept\n", "moved.txt": "two\n" },
    ],
  ] as const)("%s after updating a hardlink", async (_name, hunks, move, files) => {
    await hardlink(dir, "one\n");
    await execute(dir, patch(`*** Update File: original.txt\n${move}@@\n-one\n+two`, hunks), false);
    await expectFiles(dir, files);
  });

  it("replaces a file with a directory that the same patch deletes first", async () => {
    await fs.writeFile(path.join(dir, "x"), "file\n", "utf8");

    await applyPatch(
      "*** Begin Patch\n*** Delete File: x\n*** Add File: x/y.txt\n+new\n*** End Patch",
      { cwd: dir },
    );

    await expect(fs.readFile(path.join(dir, "x", "y.txt"), "utf8")).resolves.toBe("new\n");
  });

  it.runIf(process.platform !== "win32")(
    "rejects an update of a moved symlink path before moving it",
    async () => {
      const { link } = await symlink(dir);
      const input = patch(
        "*** Update File: link.txt\n*** Move to: moved.txt\n@@\n-keep\n+moved",
        update("link.txt", "keep", "changed"),
      );

      await expect(applyPatch(input, { cwd: dir, workspaceOnly: false })).rejects.toThrow(
        /Failed to read file to update .*link\.txt/,
      );

      expect((await fs.readdir(dir)).toSorted()).toEqual(["link.txt", "target.txt"]);
      await expect(fs.readFile(link, "utf8")).resolves.toBe("keep\n");
    },
  );

  it.runIf(process.platform !== "win32")(
    "replaces an outside directory symlink that the same patch deletes first",
    async () => {
      const outsideDir = await fs.realpath(tempDirs.make("openclaw-patch-outside-"));
      await fs.writeFile(path.join(outsideDir, "x.txt"), "keep\n", "utf8");
      await fs.symlink(outsideDir, path.join(dir, "d"));

      await execute(
        dir,
        patch(
          "*** Delete File: d",
          "*** Add File: d/x.txt\n+new",
          "*** Add File: d/..cache\n+cache",
          "*** Delete File: d/x.txt",
        ),
      );

      expect((await fs.lstat(path.join(dir, "d"))).isDirectory()).toBe(true);
      expect(await fs.readdir(path.join(dir, "d"))).toEqual(["..cache"]);
      await expect(fs.readFile(path.join(outsideDir, "x.txt"), "utf8")).resolves.toBe("keep\n");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an outside symlink update before an unrelated delete runs",
    async () => {
      const outsideDir = await fs.realpath(tempDirs.make("openclaw-patch-outside-"));
      await symlink(dir, outsideDir);
      await fs.writeFile(path.join(dir, "unrelated.txt"), "keep\n", "utf8");
      const input = patch("*** Delete File: unrelated.txt", update("link.txt", "keep", "changed"));

      await expect(applyPatch(input, { cwd: dir })).rejects.toThrow(/sandbox root/);

      await expect(fs.readFile(path.join(dir, "unrelated.txt"), "utf8")).resolves.toBe("keep\n");
    },
  );
});
