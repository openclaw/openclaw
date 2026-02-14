import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch } from "./apply-patch.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applyPatch", () => {
  it("adds a file", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      const contents = await fs.readFile(path.join(dir, "hello.txt"), "utf8");

      expect(contents).toBe("hello\n");
      expect(result.summary.added).toEqual(["hello.txt"]);
    });
  });

  it("updates and moves a file", async () => {
    await withTempDir(async (dir) => {
      const source = path.join(dir, "source.txt");
      await fs.writeFile(source, "foo\nbar\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: dest.txt
@@
 foo
-bar
+baz
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      const dest = path.join(dir, "dest.txt");
      const contents = await fs.readFile(dest, "utf8");

      expect(contents).toBe("foo\nbaz\n");
      await expect(fs.stat(source)).rejects.toBeDefined();
      expect(result.summary.modified).toEqual(["dest.txt"]);
    });
  });

  it("supports end-of-file inserts", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "end.txt");
      await fs.writeFile(target, "line1\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: end.txt
@@
+line2
*** End of File
*** End Patch`;

      await applyPatch(patch, { cwd: dir });
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("line1\nline2\n");
    });
  });

  it("rejects path traversal outside cwd", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(path.dirname(dir), "escaped.txt");
      const relativeEscape = path.relative(dir, escapedPath);

      const patch = `*** Begin Patch
*** Add File: ${relativeEscape}
+escaped
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, workspaceOnly: true })).rejects.toThrow(
        /Path escapes sandbox root/,
      );
      await expect(fs.readFile(escapedPath, "utf8")).rejects.toBeDefined();
    });
  });

  it("rejects absolute paths outside cwd", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(os.tmpdir(), `openclaw-apply-patch-${Date.now()}.txt`);

      const patch = `*** Begin Patch
*** Add File: ${escapedPath}
+escaped
*** End Patch`;

      try {
        await expect(applyPatch(patch, { cwd: dir, workspaceOnly: true })).rejects.toThrow(
          /Path escapes sandbox root/,
        );
        await expect(fs.readFile(escapedPath, "utf8")).rejects.toBeDefined();
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("allows absolute paths within cwd", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "nested", "inside.txt");
      const patch = `*** Begin Patch
*** Add File: ${target}
+inside
*** End Patch`;

      await applyPatch(patch, { cwd: dir, workspaceOnly: true });
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("inside\n");
    });
  });

  it("rejects symlink escape attempts", async () => {
    await withTempDir(async (dir) => {
      const outside = path.join(path.dirname(dir), "outside-target.txt");
      const linkPath = path.join(dir, "link.txt");
      await fs.writeFile(outside, "initial\n", "utf8");
      await fs.symlink(outside, linkPath);

      const patch = `*** Begin Patch
*** Update File: link.txt
@@
-initial
+pwned
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, workspaceOnly: true })).rejects.toThrow(
        /Symlink escapes sandbox root/,
      );
      const outsideContents = await fs.readFile(outside, "utf8");
      expect(outsideContents).toBe("initial\n");
      await fs.rm(outside, { force: true });
    });
  });

  it("allows symlinks that resolve within cwd", async () => {
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

      await applyPatch(patch, { cwd: dir, workspaceOnly: true });
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("updated\n");
    });
  });
});
