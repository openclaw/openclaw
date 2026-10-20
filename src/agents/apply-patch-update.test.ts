import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createApplyPatchTool } from "./apply-patch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runUpdate(initial: string, changes: string[]): Promise<string> {
  const dir = tempDirs.make("openclaw-apply-patch-update-");
  const file = "source.txt";
  const filePath = path.join(dir, file);
  await fs.writeFile(filePath, initial);
  const patch = ["*** Begin Patch", `*** Update File: ${file}`, ...changes, "*** End Patch"].join(
    "\n",
  );

  await createApplyPatchTool({ cwd: dir }).execute("test", { input: patch }, undefined);

  return fs.readFile(filePath, "utf8");
}

describe("apply_patch update byte preservation", () => {
  it.each<[string, string, string[], string]>([
    [
      "preserves changed and context CRLF lines",
      'class Program {\r\n  static void Main() {\r\n    Console.WriteLine("hello");\r\n  }\r\n}\r\n',
      [
        "@@",
        "  static void Main() {",
        '-    Console.WriteLine("hello");',
        '+    Console.WriteLine("world");',
        "  }",
      ],
      'class Program {\r\n  static void Main() {\r\n    Console.WriteLine("world");\r\n  }\r\n}\r\n',
    ],
    [
      "preserves CRLF across a whole-file hunk",
      "foo\r\nbar\r\n",
      ["@@", " foo", "-bar", "+baz"],
      "foo\r\nbaz\r\n",
    ],
    [
      "uses CRLF for inserted lines",
      "foo\r\nbar\r\n",
      ["@@ foo", "+middle"],
      "foo\r\nmiddle\r\nbar\r\n",
    ],
    ["keeps LF files on LF", "foo\nbar\n", ["@@", " foo", "-bar", "+baz"], "foo\nbaz\n"],
    ["adds the first line to an empty file", "", ["@@", "+first"], "first\n"],
    [
      "preserves trailing whitespace on context lines",
      "# Notes\nfirst line  \nsecond line  \nold value\ntail\n",
      ["@@", " first line", " second line", "-old value", "+new value", " tail"],
      "# Notes\nfirst line  \nsecond line  \nnew value\ntail\n",
    ],
    [
      "preserves punctuation on fuzzy context lines",
      "It’s done\nold value\n",
      ["@@", " It's done", "-old value", "+new value"],
      "It’s done\nnew value\n",
    ],
    [
      "preserves mixed endings outside the changed hunk",
      "first\r\nsecond\nthird\r\n",
      ["@@", "-second", "+changed"],
      "first\r\nchanged\nthird\r\n",
    ],
    [
      "preserves a replaced line ending in a mixed file",
      "first\r\nsecond\r\nthird\n",
      ["@@", " first", "-second", "+changed", " third"],
      "first\r\nchanged\r\nthird\n",
    ],
    [
      "preserves a UTF-8 BOM when replacing the first line",
      "\uFEFFheading\nkeep\n",
      ["@@", "-heading", "+title", " keep"],
      "\uFEFFtitle\nkeep\n",
    ],
    ["preserves a missing final newline", "foo\nbar", ["@@", " foo", "-bar", "+baz"], "foo\nbaz"],
    [
      "preserves final-newline state when one line expands",
      "head\r\nold",
      ["@@", " head", "-old", "+new one", "+new two"],
      "head\r\nnew one\r\nnew two",
    ],
    [
      "keeps the predecessor terminator when deleting an unterminated final line",
      "first\nlast",
      ["@@", " first", "-last"],
      "first\n",
    ],
    [
      "inserts at the requested context",
      "alpha\nanchor\nomega\n",
      ["@@ anchor", "+inserted"],
      "alpha\nanchor\ninserted\nomega\n",
    ],
    [
      "keeps later insertion contexts in source coordinates",
      "a\nb\nc\n",
      ["@@ a", "+after-a", "@@ b", "+after-b"],
      "a\nafter-a\nb\nafter-b\nc\n",
    ],
    [
      "inserts at the end of a file",
      "line1\n",
      ["@@", "+line2", "*** End of File"],
      "line1\nline2\n",
    ],
    [
      "preserves a missing final newline after an end-of-file insertion",
      "line1",
      ["@@", "+line2", "*** End of File"],
      "line1\nline2",
    ],
    // Fuzzy whitespace matching locates source lines; replacement content stays literal.
    [
      "writes replacement lines literally inside a tab-indented block",
      "def run(x):\n\tif x:\n\t\tprepare()\n\t\tvalue = 1\n\t\treturn value\n\treturn 0\n",
      [
        "@@",
        "     if x:",
        "         prepare()",
        "-        value = 1",
        "+        value = 2",
        "         return value",
      ],
      "def run(x):\n\tif x:\n\t\tprepare()\n        value = 2\n\t\treturn value\n\treturn 0\n",
    ],
    [
      "keeps an explicit replacement indentation change",
      "def run(x):\n\tif x:\n\t\tvalue = 1\n",
      ["@@", "     if x:", "-        value = 1", "+    value = 2"],
      "def run(x):\n\tif x:\n    value = 2\n",
    ],
  ])("%s", async (_title, initial, changes, expected) => {
    expect(await runUpdate(initial, changes)).toBe(expected);
  });
});

describe("apply_patch large updates", () => {
  it("applies a hunk larger than the engine's call argument limit", async () => {
    const added = Array.from({ length: 200_000 }, (_, index) => `+line ${index}`);
    const output = await runUpdate("start\nend\n", ["@@", " start", ...added, " end"]);
    const lines = output.split("\n");
    expect(lines).toHaveLength(200_003);
    expect(lines.at(1)).toBe("line 0");
    expect(lines.at(-2)).toBe("end");
  });

  it("keeps context-heavy large hunks linear", async () => {
    const count = 100_000;
    const initial = Array.from({ length: count }, (_, index) => `keep ${index}`);
    const changes = ["@@", ...initial.flatMap((line) => [` ${line}`, `+added ${line}`])];
    const output = await runUpdate(`${initial.join("\n")}\n`, changes);
    const lines = output.split("\n");
    expect(lines).toHaveLength(count * 2 + 1);
    expect(lines.slice(0, 2)).toEqual(["keep 0", "added keep 0"]);
  });
});
