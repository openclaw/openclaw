import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHostWorkspaceEditTool } from "./pi-tools.read.js";

function extractFirstText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const record = result as Record<string, unknown>;
  const blocks = Array.isArray(record.content) ? record.content : [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") {
      continue;
    }
    const block = b as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

describe("edit tool diff", () => {
  it("includes a unified diff in the tool result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-diff-"));
    try {
      const file = path.join(root, "demo.txt");
      await fs.writeFile(file, "old\n", "utf8");

      const tool = createHostWorkspaceEditTool(root);
      const res = await tool.execute(
        "t1",
        { path: file, oldText: "old\n", newText: "new\n" },
        undefined,
        undefined,
      );

      const text = extractFirstText(res);
      expect(text).toContain("--- a/");
      expect(text).toContain("+++ b/");
      expect(text).toContain("-old");
      expect(text).toContain("+new");

      const updated = await fs.readFile(file, "utf8");
      expect(updated).toBe("new\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
