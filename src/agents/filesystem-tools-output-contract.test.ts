import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpenClawReadTool, resolveAdaptiveReadMaxBytes } from "./agent-tools.read.js";
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

async function expectResult(
  tool: AnyAgentTool,
  args: Record<string, unknown>,
  details: Record<string, unknown>,
  exact = false,
) {
  const result = await tool.execute("contract", args);
  expectContract(tool, result.details);
  if (exact) {
    expect(result.details).toEqual(details);
  } else {
    expect(result.details).toMatchObject(details);
  }
  return result;
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

let tmpDir = "";
const write = (file: string, content: string | Buffer) =>
  fs.writeFile(path.join(tmpDir, file), content);
const read = (
  options?: Parameters<typeof createReadTool>[1],
  wrapping?: Parameters<typeof createOpenClawReadTool>[1],
) => createOpenClawReadTool(createReadTool(tmpDir, options), wrapping);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-filesystem-contract-"));
});

afterEach(async () => {
  await resetCodeModeTestState();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

it.each([
  ["empty", [], {}, "(empty directory)", undefined],
  ["complete", ["alpha.txt", "beta.txt"], {}, '"alpha.txt"\n"beta.txt"', undefined],
  [
    "paged",
    ["alpha.txt", "beta.txt"],
    { limit: 1 },
    '"alpha.txt"\n\n[More entries. Continue with the same path and after="alpha.txt".]',
    "alpha.txt",
  ],
] as const)(
  "preserves %s directory output through Code Mode",
  async (_mode, files, args, output, nextAfter) => {
    await Promise.all(files.map((file) => write(file, "fixture\n")));
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
  await write("notes.txt", "ordinary text\n");
  await write("pixel.png", Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
  await write("long.txt", "x".repeat(DEFAULT_MAX_BYTES + 1));

  const tool = read({ autoResizeImages: false });
  await expectResult(
    tool,
    { path: "notes.txt", limit: 10 },
    { kind: "text", content: "ordinary text\n" },
    true,
  );
  await expectResult(
    tool,
    { path: "pixel.png", limit: 10 },
    { kind: "image", mimeType: "image/png" },
  );
  const omitted = await expectResult(
    read({ autoResizeImages: false }, { imageSanitization: { maxBytes: 1 } }),
    { path: "pixel.png", limit: 10 },
    { kind: "text", content: expect.stringContaining("omitted image payload") },
  );
  expect(omitted.content.some((block) => block.type === "image")).toBe(false);
  await expectResult(
    tool,
    { path: "long.txt", limit: 10 },
    {
      kind: "truncated",
      truncation: { totalBytes: DEFAULT_MAX_BYTES + 1 },
    },
  );
  const missing = { path: "memory/2026-07-17.md", optional: true };
  await expectResult(tool, missing, { ...missing, kind: "not_found", status: "not_found" }, true);
  expect(compactToolOutputHint(tool.outputSchema)).toBe(
    '{ content: string; kind: "text" } | { content: string; kind: "image"; mimeType: string } | { content: string; continuation: { kind: "line"; offset: number; limit?: number } | { cursor: number; kind: "cursor"; offset: number; limit?: number }; kind: "truncated"; truncation: { firstLineExceedsLimit: boolean; lastLinePartial: boolean; maxBytes: number; maxLines: number; outputBytes: number; outputLines: number; totalBytes: number; totalLines: number; truncated: true; truncatedBy: "lines" | "bytes" } } | { kind: "not_found"; optional: true; path: string; status: "not_found" }',
  );
});

it.each([
  ["adaptive cursor", true, 0, undefined, 0],
  ["native line pages", false, 2, 500, 0],
  ["adaptive blank pages", true, 2, 500, 500],
] as const)(
  "reassembles JSON from %s without display notices",
  async (_mode, wrapped, indent, limit, leadingBlankLines) => {
    const records = Array.from({ length: 1_500 }, (_, index) => ({
      index,
      value: "é🦞".repeat(8),
    }));
    const original = "\n".repeat(leadingBlankLines) + JSON.stringify(records, null, indent) + "\n";
    await write("records.json", original);
    const base = createReadTool(tmpDir, { maxBytes: 16 * 1024 });
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

it.each([
  ["one leading blank", "\n", 52 * 1024, undefined, undefined],
  ["no leading blank", "", 52 * 1024, undefined, undefined],
  ["two leading blanks", "\n\n", 52 * 1024, undefined, undefined],
  ["short file", "\n", 10, undefined, undefined],
  ["offset on blank", "\n", 52 * 1024, 2, undefined],
  ["blank then fitting page", "\n", 2_000, undefined, 1_024],
] as const)(
  "preserves %s across read continuations",
  async (_name, prefix, size, offset, maxBytes) => {
    const expected = `${prefix}${JSON.stringify({ generated: "x".repeat(size) })}`;
    await write("paged.json", `${offset ? "before\n" : ""}${expected}`);
    const tool = read({ maxBytes: maxBytes ?? resolveAdaptiveReadMaxBytes() });
    let args: { path: string; offset?: number; cursor?: number; limit?: number } = {
      path: "paged.json",
      ...(offset ? { offset } : {}),
    };
    let actual = "";
    let display = "";
    let separator = "";
    for (let page = 0; page < 8; page++) {
      const result = await tool.execute(`read-page-${page}`, args);
      expectContract(tool, result.details);
      const details = result.details;
      if (details.kind !== "text" && details.kind !== "truncated") {
        throw new Error("Expected file text");
      }
      const text = result.content.find((block) => block.type === "text")!.text;
      actual += separator + details.content;
      display +=
        separator +
        (details.kind === "truncated" ? text.slice(0, text.lastIndexOf("\n\n[")) : text);
      if (details.kind === "text") {
        expect(actual).toBe(expected);
        expect(display).toBe(expected);
        return;
      }
      const { kind, ...continuation } = details.continuation;
      separator = kind === "line" ? "\n" : "";
      args = { path: "paged.json", ...continuation };
    }
    throw new Error("Read did not reach EOF");
  },
);

it("bounds structured blank pages independently of their short display summary", async () => {
  await write("blank.txt", "\n".repeat(10_000));
  const tool = read(undefined, { modelContextWindowTokens: 1_024 });
  const result = await tool.execute("blank-budget", { path: "blank.txt" });
  expectContract(tool, result.details);
  const details = result.details;
  if (details.kind !== "text" && details.kind !== "truncated") {
    throw new Error("Expected structured file text");
  }
  expect(toolResultFitsBudget(details.content, resolveToolResultBudget(1_024))).toBe(true);
});

it("retains continuation when its notice exceeds the rebound budget", async () => {
  await write("continued.txt", "x".repeat(2_000));
  const tool = read({ maxBytes: 200 }, { modelContextWindowTokens: 100 });
  await expectResult(
    tool,
    { path: "continued.txt" },
    {
      kind: "truncated",
      continuation: { kind: "cursor", offset: 1, cursor: expect.any(Number) },
    },
  );
});

it("honors normalized limit 0 without automatic paging", async () => {
  await write("limited.txt", "alpha\nbeta\ngamma");
  await expectResult(
    read(),
    { path: "limited.txt", limit: 0 },
    {
      kind: "truncated",
      content: "alpha",
      continuation: { kind: "line", offset: 2, limit: 1 },
    },
  );
});

it("validates edit changed and no-op results", async () => {
  const filePath = path.join(tmpDir, "edit.txt");
  await write("edit.txt", "before\n");
  const tool = createEditTool(tmpDir) as unknown as AnyAgentTool;
  const edit = (oldText: string) => ({
    path: filePath,
    edits: [{ oldText, newText: "after" }],
  });
  await expectResult(tool, edit("before"), { changed: true });
  await expectResult(tool, edit("after"), { changed: false }, true);
  expect(compactToolOutputHint(tool.outputSchema)).toBe(
    "{ changed: false } | { changed: true; diff: string; patch: string; firstChangedLine?: number }",
  );
});

it("validates write created, overwrite, unknown-state, and no-op results", async () => {
  const tool = createWriteTool(tmpDir) as unknown as AnyAgentTool;
  const check = (file: string, content: string, details: Record<string, unknown>, exact = false) =>
    expectResult(tool, { path: file, content }, details, exact);
  await check("write.txt", "one\n", { changed: true, created: true });
  await check("write.txt", "two\n", { changed: true, created: false });
  await check("write.txt", "two\n", { changed: false }, true);
  const large = "x".repeat(1024 * 1024 + 1);
  await write("large.txt", large);
  await check("large.txt", "replacement\n", { changed: true, created: false }, true);
  await check("large-created.txt", large, { changed: true, created: true }, true);
  expectContract(tool, { changed: true });
  expect(compactToolOutputHint(tool.outputSchema)).toBe(
    "{ changed: false } | { changed: true; created: true; diff: string; patch: string; firstChangedLine?: number } | { changed: true; created: false; diff: string; patch: string; firstChangedLine?: number } | { changed: true; created?: boolean }",
  );
});

it("validates apply_patch path summaries", async () => {
  const tool = createApplyPatchTool({ cwd: tmpDir }) as unknown as AnyAgentTool;
  await expectResult(
    tool,
    {
      input: "*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch",
    },
    { summary: { added: ["added.txt"], modified: [], deleted: [] } },
    true,
  );
  expect(compactToolOutputHint(tool.outputSchema)).toBe(
    "{ summary: { added: Array<string>; deleted: Array<string>; modified: Array<string> } }",
  );
});
