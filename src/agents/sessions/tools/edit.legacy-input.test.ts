import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createAgentHarnessToolExecutionBoundaryRegistry } from "../../harness/tool-execution.js";
import { runAgentHarnessToolInvocation } from "../../harness/tool-invocation.js";
import { createEditTool } from "./edit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const original = "alpha\nbefore\nomega\n";
const pair = { oldText: "before", newText: "after" };
const alpha = { oldText: "alpha", newText: "ALPHA" };
const batch = [alpha, { ...pair, reason: "extra model metadata" }];
const batchResult = "ALPHA\nafter\nomega\n";
let tool: ReturnType<typeof createEditTool>, filePath: string;
beforeEach(async () => {
  const cwd = tempDirs.make("openclaw-edit-legacy-");
  filePath = path.join(cwd, "example.txt");
  await fs.writeFile(filePath, original);
  tool = createEditTool(cwd);
});
const prepare = (input: object) => tool.prepareArguments?.({ path: filePath, ...input });
const expectFile = (text = original) => expect(fs.readFile(filePath, "utf8")).resolves.toBe(text);
function apply(input: object) {
  const args = prepare(input);
  if (!Value.Check(tool.parameters, args)) {
    throw new Error("Prepared replacements did not satisfy the edit schema");
  }
  return tool.execute("edit", args);
}

it.each([
  { edits: "[{bad json" },
  { edits: '[{"oldText":"before","newText":"after"}' },
  { edits: "[{bad json", oldText: "before" },
  { edits: "[{bad json", oldText: 42, newText: "after" },
])("rejects malformed edits before execution: %j", async (args) => {
  const execute = vi.spyOn(tool, "execute");
  await expect(
    runAgentHarnessToolInvocation({
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
    }),
  ).rejects.toThrow(
    "Could not parse edits as JSON. Provide a complete JSON array of replacements.",
  );
  expect(execute).not.toHaveBeenCalled();
  await expectFile();
});

it.each([
  ["[{bad json", "after", "alpha\nafter\nomega\n"],
  ["[{bad json", "", "alpha\n\nomega\n"],
  [batch, "after", batchResult],
  [JSON.stringify(batch), "after", batchResult],
  [[alpha], "after", batchResult],
] as const)("applies replacements once: %j", async (edits, newText, expected) => {
  await apply({ ...pair, edits, newText });
  await expectFile(expected);
});

it.each([
  { name: "conflicting legacy pair", edits: [pair], newText: "different" },
  { name: "duplicate batch entries", edits: [pair, pair], newText: "after" },
])("rejects $name without writing", async ({ edits, newText }) => {
  await expect(apply({ ...pair, edits, newText })).rejects.toThrow(/overlap/);
  await expectFile();
});

it("rejects malformed entries despite a valid legacy pair", () => {
  expect(Value.Check(tool.parameters, prepare({ edits: [{ oldText: "before" }], ...pair }))).toBe(
    false,
  );
});
