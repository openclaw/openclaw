import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createAgentHarnessToolExecutionBoundaryRegistry } from "../../harness/tool-execution.js";
import { runAgentHarnessToolInvocation } from "../../harness/tool-invocation.js";
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
  it.each([
    { edits: "[{bad json" },
    { edits: '[{"oldText":"before","newText":"after"}' },
    { edits: "[{bad json", oldText: "before" },
    { edits: "[{bad json", oldText: 42, newText: "after" },
  ])("reports unparseable edits before execution: %j", async (args) => {
    const { tool, filePath } = await createFixture();
    const execute = vi.spyOn(tool, "execute");
    const invocation = runAgentHarnessToolInvocation({
      tool,
      call: {
        toolCallId: "malformed-edits",
        toolName: "edit",
        arguments: { path: filePath, ...args },
      },
      signal: new AbortController().signal,
      boundaries: createAgentHarnessToolExecutionBoundaryRegistry(),
      applyMiddleware: async (event) => event.result,
      onResult: ({ result }) => result,
      onError: ({ error }) => {
        throw error;
      },
    });

    await expect(invocation).rejects.toThrow(
      "Could not parse edits as JSON. Provide a complete JSON array of replacements.",
    );
    expect(execute).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("alpha\nbefore\nomega\n");
  });

  it.each(["after", ""])(
    "uses a valid legacy pair with newText %j when serialized edits cannot be parsed",
    async (newText) => {
      const { tool, filePath } = await createFixture();
      const prepared = prepare(tool, {
        path: filePath,
        edits: "[{bad json",
        oldText: "before",
        newText,
      });
      await tool.execute("legacy-fallback", prepared, undefined);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(`alpha\n${newText}\nomega\n`);
    },
  );

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
