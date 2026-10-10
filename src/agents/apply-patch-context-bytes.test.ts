import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-context-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applyPatch context byte preservation", () => {
  it.each([
    {
      name: "an internal U+2000 quad space",
      files: { "source.txt": "# wait\u200030 seconds\nold\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
@@
 # wait 30 seconds
-old
+new\u2000value\u2001
*** End Patch`,
      expected: { "source.txt": "# wait\u200030 seconds\nnew\u2000value\u2001\n" },
      missing: [],
    },
    {
      name: "an end-of-file replacement",
      files: { "source.txt": "head\nlast context  \nold\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
@@
 last context
-old
+new
*** End of File
*** End Patch`,
      expected: { "source.txt": "head\nlast context  \nnew\n" },
      missing: [],
    },
    {
      name: "multiple chunks with repeated context",
      files: {
        "source.txt": "anchor  \nold one\nmarker  \nanchor  \nold two\nmarker  \n",
      },
      patch: `*** Begin Patch
*** Update File: source.txt
@@
 anchor
-old one
+new one
 marker
@@
 anchor
-old two
+new two
 marker
*** End Patch`,
      expected: {
        "source.txt": "anchor  \nnew one\nmarker  \nanchor  \nnew two\nmarker  \n",
      },
      missing: [],
    },
    {
      name: "a move",
      files: { "source.txt": "It\u2019s here\nold\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
 It's here
-old
+new
*** End Patch`,
      expected: { "destination.txt": "It\u2019s here\nnew\n" },
      missing: ["source.txt"],
    },
    {
      name: "a pure insertion after fuzzy context",
      files: { "source.txt": "anchor  \ntail\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
@@ anchor
+inserted
*** End Patch`,
      expected: { "source.txt": "anchor  \ninserted\ntail\n" },
      missing: [],
    },
  ])("keeps context bytes through $name", async ({ files, patch, expected, missing }) => {
    await withTempDir(async (dir) => {
      await Promise.all(
        Object.entries(files).map(([filePath, contents]) =>
          fs.writeFile(path.join(dir, filePath), contents, "utf8"),
        ),
      );

      await applyPatch(patch, { cwd: dir });

      for (const [filePath, contents] of Object.entries(expected)) {
        await expect(fs.readFile(path.join(dir, filePath), "utf8")).resolves.toBe(contents);
      }
      for (const filePath of missing) {
        await expect(fs.stat(path.join(dir, filePath))).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  it.each([
    {
      title: "supports end-of-file inserts",
      fileName: "end.txt",
      initialContent: "line1\n",
      patchText: `*** Begin Patch
*** Update File: end.txt
@@
+line2
*** End of File
*** End Patch`,
      expectedPath: "/sandbox/end.txt",
      expectedContent: "line1\nline2\n",
    },
  ])("$title", async ({ fileName, initialContent, patchText, expectedPath, expectedContent }) => {
    const memory = createMemoryPatchSandbox({
      [fileName]: initialContent,
    });
    const patch = patchText;

    await applyPatch(patch, memory.options);

    expect(memory.files.get(expectedPath)).toBe(expectedContent);
  });

  it("preserves formatting for same-path move no-op hunks", async () => {
    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: ./source.txt
@@
 foo
-bar
+bar
*** End Patch`;
    for (const initial of ["foo\r\nbar\r\n", "foo\nbar"]) {
      const memory = createMemoryPatchSandbox({ "source.txt": initial });

      const result = await applyPatch(patch, memory.options);

      expect(result.noOp).toBe(true);
      expect(memory.files.get("/sandbox/source.txt")).toBe(initial);
      expect(memory.writeFile.mock.calls).toHaveLength(0);
    }
  });
});
