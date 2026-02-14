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

  it("rejects path traversal in add file", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: ../../../etc/malicious
+pwned
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Path escapes sandbox root/);
    });
  });

  it("rejects path traversal in delete file", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Delete File: ../../../etc/passwd
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Path escapes sandbox root/);
    });
  });

  it("rejects path traversal in update file", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "legit.txt"), "ok\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: ../../etc/shadow
@@
 ok
+injected
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Path escapes sandbox root/);
    });
  });

  it("rejects path traversal in move target", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "source.txt"), "foo\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: ../../../tmp/escaped
@@
 foo
+bar
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Path escapes sandbox root/);
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
});
