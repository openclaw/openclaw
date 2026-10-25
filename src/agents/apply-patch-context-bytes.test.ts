import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";

function update(hunk: string, move?: string) {
  return `*** Begin Patch\n*** Update File: source.txt\n${move ? `*** Move to: ${move}\n` : ""}${hunk}\n*** End Patch`;
}

describe("applyPatch context byte preservation", () => {
  it.each([
    ...["\u2000", "\u2001"].map((space) => ({
      name: `an internal U+${space.charCodeAt(0).toString(16)} quad space`,
      initial: `# wait${space}30 seconds\nold\n`,
      hunk: "@@\n # wait 30 seconds\n-old\n+new\u2000value\u2001",
      expected: `# wait${space}30 seconds\nnew\u2000value\u2001\n`,
    })),
    {
      name: "an end-of-file replacement",
      initial: "head\nlast context  \nold\n",
      hunk: "@@\n last context\n-old\n+new\n*** End of File",
      expected: "head\nlast context  \nnew\n",
    },
    {
      name: "a move",
      initial: "It\u2019s here\nold\n",
      hunk: "@@\n It's here\n-old\n+new",
      expected: "It\u2019s here\nnew\n",
      move: "destination.txt",
    },
    {
      name: "a pure insertion after fuzzy context",
      initial: "anchor  \ntail\n",
      hunk: "@@ anchor\n+inserted",
      expected: "anchor  \ninserted\ntail\n",
    },
  ])("keeps context bytes through $name", async ({ initial, hunk, expected, move }) => {
    await withTempDir("openclaw-patch-context-", async (dir) => {
      const source = path.join(dir, "source.txt");
      await fs.writeFile(source, initial, "utf8");
      await applyPatch(update(hunk, move), { cwd: dir });
      await expect(fs.readFile(path.join(dir, move ?? "source.txt"), "utf8")).resolves.toBe(
        expected,
      );
      if (move) {
        await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  it.each([undefined, "./source.txt"])("preserves no-op formatting (move: %s)", async (move) => {
    for (const initial of ["foo\r\nbar\r\n", "foo\nbar"]) {
      const memory = createMemoryPatchSandbox({ "source.txt": initial });
      const result = await applyPatch(update("@@\n foo\n-bar\n+bar", move), memory.options);
      expect(result.noOp).toBe(true);
      expect(memory.files.get("/sandbox/source.txt")).toBe(initial);
      expect(memory.writeFile.mock.calls).toHaveLength(0);
    }
  });

  it("applies a real deletion of the sole blank line", async () => {
    const memory = createMemoryPatchSandbox({ "source.txt": "\n" });
    const result = await applyPatch(update("@@\n-"), memory.options);
    expect(result.noOp).toBeUndefined();
    expect(memory.files.get("/sandbox/source.txt")).toBe("");
    expect(memory.writeFile.mock.calls).toHaveLength(1);
  });
});
