import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyPatch } from "./apply-patch.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  return fn(await fs.realpath(tempDirs.make("openclaw-patch-alias-")));
}

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
