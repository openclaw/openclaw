import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createEditTool } from "./edit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture() {
  const cwd = tempDirs.make("openclaw-edit-legacy-");
  const filePath = path.join(cwd, "example.txt");
  await fs.writeFile(filePath, "alpha\nbefore\nomega\n");
  return { tool: createEditTool(cwd), filePath };
}

function prepare(tool: ReturnType<typeof createEditTool>, input: unknown) {
  const prepared = tool.prepareArguments?.(input);
  if (!Value.Check(tool.parameters, prepared)) {
    throw new Error("Prepared replacements did not satisfy the edit schema");
  }
  return prepared;
}

describe("legacy edit input", () => {
  it.each(["array", "serialized", "distinct"] as const)(
    "applies the batch and legacy pair once with %s edits",
    async (shape) => {
      const { tool, filePath } = await createFixture();
      const edits = [
        { oldText: "alpha", newText: "ALPHA" },
        ...(shape === "distinct"
          ? []
          : [{ oldText: "before", newText: "after", reason: "extra model metadata" }]),
      ];
      const prepared = prepare(tool, {
        path: filePath,
        edits: shape === "serialized" ? JSON.stringify(edits) : edits,
        oldText: "before",
        newText: "after",
      });
      await tool.execute("legacy-duplicate", prepared, undefined);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("ALPHA\nafter\nomega\n");
    },
  );

  it.each(["conflicting legacy pair", "duplicate batch entries"] as const)(
    "continues rejecting %s without writing",
    async (scenario) => {
      const { tool, filePath } = await createFixture();
      const pair = { oldText: "before", newText: "after" };
      const prepared = prepare(tool, {
        path: filePath,
        edits: scenario === "duplicate batch entries" ? [pair, pair] : [pair],
        oldText: "before",
        newText: scenario === "conflicting legacy pair" ? "different" : "after",
      });
      await expect(tool.execute("legacy-overlap", prepared, undefined)).rejects.toThrow(/overlap/);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("alpha\nbefore\nomega\n");
    },
  );

  it("keeps malformed batch entries invalid when a valid legacy pair is supplied", async () => {
    const { tool, filePath } = await createFixture();
    const prepared = tool.prepareArguments?.({
      path: filePath,
      edits: [{ oldText: "before" }],
      oldText: "before",
      newText: "after",
    });
    expect(Value.Check(tool.parameters, prepared)).toBe(false);
  });
});
