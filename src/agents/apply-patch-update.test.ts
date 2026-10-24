import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createApplyPatchTool } from "./apply-patch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runUpdate(initial: string, changes: string): Promise<string> {
  const dir = tempDirs.make("openclaw-apply-patch-update-");
  const file = path.join(dir, "source.txt");
  await fs.writeFile(file, initial);
  const input = `*** Begin Patch\n*** Update File: source.txt\n${changes}\n*** End Patch`;
  await createApplyPatchTool({ cwd: dir }).execute("test", { input }, undefined);
  return fs.readFile(file, "utf8");
}

it.each([
  [
    "changed/context CRLF",
    "top\r\n  block\r\n    old\r\n  end\r\ntail\r\n",
    "@@\n  block\n-    old\n+    new\n  end",
    "top\r\n  block\r\n    new\r\n  end\r\ntail\r\n",
  ],
  ["whole-file CRLF", "foo\r\nbar\r\n", "@@\n foo\n-bar\n+baz", "foo\r\nbaz\r\n"],
  ["inserted CRLF", "foo\r\nbar\r\n", "@@ foo\n+middle", "foo\r\nmiddle\r\nbar\r\n"],
  ["LF", "foo\nbar\n", "@@\n foo\n-bar\n+baz", "foo\nbaz\n"],
  ["empty file", "", "@@\n+first", "first\n"],
  [
    "context trailing whitespace",
    "head\na  \nb  \nold\ntail\n",
    "@@\n a\n b\n-old\n+new\n tail",
    "head\na  \nb  \nnew\ntail\n",
  ],
  [
    "fuzzy punctuation context",
    "It’s done\nold\n",
    "@@\n It's done\n-old\n+new",
    "It’s done\nnew\n",
  ],
  ["mixed endings outside hunk", "a\r\nb\nc\r\n", "@@\n-b\n+new", "a\r\nnew\nc\r\n"],
  ["mixed endings within hunk", "a\r\nb\r\nc\n", "@@\n a\n-b\n+new\n c", "a\r\nnew\r\nc\n"],
  ["UTF-8 BOM", "\uFEFFheading\nkeep\n", "@@\n-heading\n+title\n keep", "\uFEFFtitle\nkeep\n"],
  ["missing final newline", "foo\nbar", "@@\n foo\n-bar\n+baz", "foo\nbaz"],
  [
    "unterminated line expansion",
    "head\r\nold",
    "@@\n head\n-old\n+one\n+two",
    "head\r\none\r\ntwo",
  ],
  ["unterminated final line deletion", "first\nlast", "@@\n first\n-last", "first\n"],
  ["context insertion", "a\nanchor\nz\n", "@@ anchor\n+inserted", "a\nanchor\ninserted\nz\n"],
  ["source-coordinate insertions", "a\nb\nc\n", "@@ a\n+x\n@@ b\n+y", "a\nx\nb\ny\nc\n"],
  ["EOF insertion", "line1\n", "@@\n+line2\n*** End of File", "line1\nline2\n"],
  ["unterminated EOF insertion", "line1", "@@\n+line2\n*** End of File", "line1\nline2"],
  // Matching may ignore indentation; changed lines must still be written literally.
  [
    "literal replacement in tab block",
    "def f():\n\tif x:\n\t\ta()\n\t\told\n\t\tb()\n\tend\n",
    "@@\n     if x:\n         a()\n-        old\n+        new\n         b()",
    "def f():\n\tif x:\n\t\ta()\n        new\n\t\tb()\n\tend\n",
  ],
  [
    "explicit indentation change",
    "def f():\n\tif x:\n\t\told\n",
    "@@\n     if x:\n-        old\n+    new",
    "def f():\n\tif x:\n    new\n",
  ],
])("preserves update bytes: %s", async (_case, initial, changes, expected) => {
  expect(await runUpdate(initial, changes)).toBe(expected);
});

it("applies a hunk larger than the engine's call argument limit", async () => {
  const added = Array.from({ length: 200_000 }, (_, index) => `+line ${index}`);
  const output = await runUpdate("start\nend\n", ["@@", " start", ...added, " end"].join("\n"));
  const lines = output.split("\n");
  expect(lines).toHaveLength(200_003);
  expect(lines.at(1)).toBe("line 0");
  expect(lines.at(-2)).toBe("end");
});

it("keeps context-heavy large hunks linear", async () => {
  const count = 100_000;
  const initial = Array.from({ length: count }, (_, index) => `keep ${index}`);
  const changes = ["@@", ...initial.flatMap((line) => [` ${line}`, `+added ${line}`])].join("\n");
  const output = await runUpdate(`${initial.join("\n")}\n`, changes);
  const lines = output.split("\n");
  expect(lines).toHaveLength(count * 2 + 1);
  expect(lines.slice(0, 2)).toEqual(["keep 0", "added keep 0"]);
});
