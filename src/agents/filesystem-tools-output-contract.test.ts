import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createEditTool, createReadTool, createWriteTool } from "./sessions/index.js";
import { createLsTool } from "./sessions/tools/ls.js";
import { DEFAULT_MAX_BYTES } from "./sessions/tools/truncate.js";
import { resolveToolResultBudget, toolResultFitsBudget } from "./tool-result-limits.js";
import { compactToolOutputHint } from "./tool-schema-hints.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function expectContract(tool: AnyAgentTool, details: unknown): void {
  expect(tool.outputSchema).toBeDefined();
  expect(Value.Check(tool.outputSchema!, details)).toBe(true);
}

async function callThroughCodeMode(tool: AnyAgentTool, args: Record<string, unknown>) {
  const harness = createCodeModeHarness();
  applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, tool] });
  return await runUntilCompleted({
    execTool: harness.tools[0]!,
    waitTool: harness.tools[1]!,
    code: `return await ${tool.name}(${JSON.stringify(args)});`,
  });
}

describe("filesystem tool output contracts", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-filesystem-contract-"));
  });

  afterEach(async () => {
    await resetCodeModeTestState();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each([
    { mode: "empty", files: [], args: {}, output: "(empty directory)" },
    {
      mode: "complete",
      files: ["alpha.txt", "beta.txt"],
      args: {},
      output: '"alpha.txt"\n"beta.txt"',
    },
    {
      mode: "paged",
      files: ["alpha.txt", "beta.txt"],
      args: { limit: 1 },
      output: '"alpha.txt"\n\n[More entries. Continue with the same path and after="alpha.txt".]',
      nextAfter: "alpha.txt",
    },
  ])(
    "preserves $mode directory output through Code Mode",
    async ({ files, args, output, nextAfter }) => {
      await Promise.all(files.map((file) => fs.writeFile(path.join(tmpDir, file), "fixture\n")));
      const tool = createLsTool(tmpDir) as unknown as AnyAgentTool;
      const direct = await tool.execute("direct-ls", args);
      const result = await callThroughCodeMode(tool, args);

      expect(direct.content).toEqual([{ type: "text", text: output }]);
      expect(result).toMatchObject({
        status: "completed",
        value: { content: output, ...(nextAfter === undefined ? {} : { nextAfter }) },
      });
    },
  );

  it("validates read text, image, truncation, and optional-not-found results", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "ordinary text\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "pixel.png"), Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
    await fs.writeFile(path.join(tmpDir, "long.txt"), "x".repeat(DEFAULT_MAX_BYTES + 1), "utf8");

    const tool = createOpenClawReadTool(
      createReadTool(tmpDir, { autoResizeImages: false }) as unknown as AnyAgentTool,
    );
    const text = await tool.execute("read-text", { path: "notes.txt", limit: 10 });
    const image = await tool.execute("read-image", { path: "pixel.png", limit: 10 });
    const truncated = await tool.execute("read-truncated", { path: "long.txt", limit: 10 });
    const notFound = await tool.execute("read-not-found", {
      path: "memory/2026-07-17.md",
      optional: true,
    });

    for (const result of [text, image, truncated, notFound]) {
      expectContract(tool, result.details);
    }
    expect(text.details).toEqual({ kind: "text", content: "ordinary text\n" });
    expect(image.details).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(truncated.details).toMatchObject({
      kind: "truncated",
      truncation: { totalBytes: DEFAULT_MAX_BYTES + 1 },
    });
    expect(notFound.details).toEqual({
      kind: "not_found",
      status: "not_found",
      path: "memory/2026-07-17.md",
      optional: true,
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ content: string; kind: "text" } | { content: string; kind: "image"; mimeType: string } | { content: string; continuation: { kind: "line"; offset: number; limit?: number } | { cursor: number; kind: "cursor"; offset: number; limit?: number }; kind: "truncated"; truncation: { firstLineExceedsLimit: boolean; lastLinePartial: boolean; maxBytes: number; maxLines: number; outputBytes: number; outputLines: number; totalBytes: number; totalLines: number; truncated: true; truncatedBy: "lines" | "bytes" } } | { kind: "not_found"; optional: true; path: string; status: "not_found" }',
    );
  });

  it.each([
    { mode: "native lines", wrapped: false, indent: 2, limit: undefined },
    { mode: "native cursor", wrapped: false, indent: 0, limit: undefined },
    { mode: "adaptive lines", wrapped: true, indent: 2, limit: undefined },
    { mode: "adaptive cursor", wrapped: true, indent: 0, limit: undefined },
    { mode: "native explicit line pages", wrapped: false, indent: 2, limit: 500 },
    { mode: "adaptive explicit line pages", wrapped: true, indent: 2, limit: 500 },
    {
      mode: "adaptive blank line pages",
      wrapped: true,
      indent: 2,
      limit: 500,
      leadingBlankLines: 500,
    },
  ])(
    "reassembles JSON from $mode without parsing display notices",
    async ({ wrapped, indent, limit, leadingBlankLines = 0 }) => {
      const records = Array.from({ length: 1_500 }, (_, index) => ({
        index,
        value: "é🦞".repeat(8),
      }));
      const original =
        "\n".repeat(leadingBlankLines) + JSON.stringify(records, null, indent) + "\n";
      await fs.writeFile(path.join(tmpDir, "records.json"), original);
      const base = createReadTool(tmpDir, { maxBytes: 16 * 1024 }) as unknown as AnyAgentTool;
      const tool = wrapped ? createOpenClawReadTool(base) : base;
      const first = await tool.execute("first-page", { path: "records.json" });
      expectContract(tool, first.details);
      expect(JSON.stringify(first.content)).toContain("to continue.");
      const harness = createCodeModeHarness();
      applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, tool] });
      const result = await runUntilCompleted({
        execTool: harness.tools[0]!,
        waitTool: harness.tools[1]!,
        code: `
        let content = "";
        let next = { path: "records.json", limit: ${limit ?? "undefined"} };
        let delimiter = "";
        for (let page = 0; page < 32; page++) {
          const part = await read(next);
          content += delimiter + part.content;
          if (part.kind === "text") {
            const records = JSON.parse(content);
            return { count: records.length, last: records.at(-1), length: content.length };
          }
          if (part.kind !== "truncated") throw new Error("unexpected read result");
          const { kind, ...continuation } = part.continuation;
          next = { path: "records.json", ...continuation };
          delimiter = kind === "line" ? "\\n" : "";
        }
        throw new Error("pagination did not reach EOF");
      `,
      });
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(result.value).toEqual({
        count: records.length,
        last: records.at(-1),
        length: original.length,
      });
    },
  );

  it("bounds structured blank pages independently of their short display summary", async () => {
    await fs.writeFile(path.join(tmpDir, "blank.txt"), "\n".repeat(10_000));
    const tool = createOpenClawReadTool(createReadTool(tmpDir) as unknown as AnyAgentTool, {
      modelContextWindowTokens: 1_024,
    });
    const result = await tool.execute("blank-budget", { path: "blank.txt" });
    expectContract(tool, result.details);
    const details = result.details;
    if (
      !details ||
      typeof details !== "object" ||
      !("content" in details) ||
      typeof details.content !== "string"
    ) {
      throw new Error("Expected structured file text");
    }
    expect(toolResultFitsBudget(details.content, resolveToolResultBudget(1_024))).toBe(true);
  });

  it("retains source continuation when only its notice exceeds the rebound budget", async () => {
    await fs.writeFile(path.join(tmpDir, "continued.txt"), "x".repeat(2_000));
    const base = createReadTool(tmpDir, { maxBytes: 200 }) as unknown as AnyAgentTool;
    const tool = createOpenClawReadTool(base, { modelContextWindowTokens: 100 });
    const result = await tool.execute("continued-rebound", { path: "continued.txt" });
    expectContract(tool, result.details);
    expect(result.details).toMatchObject({
      kind: "truncated",
      continuation: { kind: "cursor", offset: 1, cursor: expect.any(Number) },
    });
  });

  it.each([0, 0.5])(
    "honors normalized explicit limit %s without automatic paging",
    async (limit) => {
      await fs.writeFile(path.join(tmpDir, "limited.txt"), "alpha\nbeta\ngamma");
      const tool = createOpenClawReadTool(createReadTool(tmpDir) as unknown as AnyAgentTool);
      const result = await tool.execute("normalized-limit", { path: "limited.txt", limit });
      expectContract(tool, result.details);
      expect(result.details).toMatchObject({
        kind: "truncated",
        content: "alpha",
        continuation: { kind: "line", offset: 2, limit: 1 },
      });
    },
  );

  it("validates edit changed and no-op results", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    await fs.writeFile(filePath, "before\n", "utf8");
    const tool = createEditTool(tmpDir) as unknown as AnyAgentTool;
    const changed = await tool.execute("edit-changed", {
      path: filePath,
      edits: [{ oldText: "before", newText: "after" }],
    });
    const noOp = await tool.execute("edit-no-op", {
      path: filePath,
      edits: [{ oldText: "after", newText: "after" }],
    });

    expectContract(tool, changed.details);
    expectContract(tool, noOp.details);
    expect(changed.details).toMatchObject({ changed: true });
    expect(noOp.details).toEqual({ changed: false });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ changed: false } | { changed: true; diff: string; patch: string; firstChangedLine?: number }",
    );
  });

  it("validates write created, overwrite, unknown-state, and no-op results", async () => {
    const tool = createWriteTool(tmpDir) as unknown as AnyAgentTool;
    const created = await tool.execute("write-created", { path: "write.txt", content: "one\n" });
    const overwritten = await tool.execute("write-overwrite", {
      path: "write.txt",
      content: "two\n",
    });
    const noOp = await tool.execute("write-no-op", { path: "write.txt", content: "two\n" });
    await fs.writeFile(path.join(tmpDir, "large.txt"), "x".repeat(1024 * 1024 + 1), "utf8");
    const unknownOverwrite = await tool.execute("write-unknown-overwrite", {
      path: "large.txt",
      content: "replacement\n",
    });
    const boundedCreate = await tool.execute("write-bounded-create", {
      path: "large-created.txt",
      content: "x".repeat(1024 * 1024 + 1),
    });

    for (const result of [created, overwritten, unknownOverwrite, boundedCreate, noOp]) {
      expectContract(tool, result.details);
    }
    expectContract(tool, { changed: true });
    expect(created.details).toMatchObject({ changed: true, created: true });
    expect(overwritten.details).toMatchObject({ changed: true, created: false });
    expect(unknownOverwrite.details).toEqual({ changed: true, created: false });
    expect(boundedCreate.details).toEqual({ changed: true, created: true });
    expect(noOp.details).toEqual({ changed: false });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ changed: false } | { changed: true; created: true; diff: string; patch: string; firstChangedLine?: number } | { changed: true; created: false; diff: string; patch: string; firstChangedLine?: number } | { changed: true; created?: boolean }",
    );
  });

  it("validates apply_patch path summaries", async () => {
    const tool = createApplyPatchTool({ cwd: tmpDir }) as unknown as AnyAgentTool;
    const result = await tool.execute("patch-add", {
      input: "*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch",
    });

    expectContract(tool, result.details);
    expect(result.details).toEqual({
      summary: { added: ["added.txt"], modified: [], deleted: [] },
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ summary: { added: Array<string>; deleted: Array<string>; modified: Array<string> } }",
    );
  });
});
