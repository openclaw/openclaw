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

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function expectContract(tool: AnyAgentTool, details: unknown): void {
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
  expect(result.details)[exact ? "toEqual" : "toMatchObject"](details);
  return result;
}

async function runCodeMode(tool: AnyAgentTool, code: string) {
  const harness = createCodeModeHarness();
  applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, tool] });
  return await runUntilCompleted({
    execTool: harness.tools[0]!,
    waitTool: harness.tools[1]!,
    code,
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
    const result = await runCodeMode(tool, `return await ${tool.name}(${JSON.stringify(args)});`);

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
  const check = (filePath: string, details: Record<string, unknown>, exact = false) =>
    expectResult(tool, { path: filePath, limit: 10 }, details, exact);
  await check("notes.txt", { kind: "text", content: "ordinary text\n" }, true);
  await check("pixel.png", { kind: "image", mimeType: "image/png" });
  const omitted = await expectResult(
    read({ autoResizeImages: false }, { imageSanitization: { maxBytes: 1 } }),
    { path: "pixel.png", limit: 10 },
    { kind: "text", content: expect.stringContaining("omitted image payload") },
  );
  expect(omitted.content.some((block) => block.type === "image")).toBe(false);
  await check("long.txt", { kind: "truncated", truncation: { totalBytes: DEFAULT_MAX_BYTES + 1 } });
  const missing = { path: "memory/2026-07-17.md", optional: true };
  await expectResult(tool, missing, { ...missing, kind: "not_found", status: "not_found" }, true);
});

it.each([
  ["adaptive cursor", true, 0, 0, undefined, undefined, 16 * 1024, 0],
  ["native line pages", false, 2, 0, 500, undefined, 16 * 1024, 0],
  ["adaptive blank pages", true, 2, 500, 500, undefined, 16 * 1024, 0],
  ["one leading blank", true, undefined, 1, undefined, undefined, undefined, 52 * 1024],
  ["short file", true, undefined, 1, undefined, undefined, undefined, 10],
  ["offset on blank", true, undefined, 1, undefined, 2, undefined, 52 * 1024],
  ["blank then fitting page", true, undefined, 1, undefined, undefined, 1_024, 2_000],
] as const)(
  "reassembles %s through Code Mode and preserves its display bytes",
  async (_name, wrapped, indent, blanks, limit, offset, maxBytes, size) => {
    const records = Array.from({ length: 1_500 }, (_, index) => ({
      index,
      value: "é🦞".repeat(8),
    }));
    const data = indent === undefined ? { generated: "x".repeat(size) } : records;
    const original =
      "\n".repeat(blanks) + JSON.stringify(data, null, indent) + (indent === undefined ? "" : "\n");
    await write("records.json", `${offset ? "before\n" : ""}${original}`);
    const base = createReadTool(tmpDir, {
      maxBytes: maxBytes ?? resolveAdaptiveReadMaxBytes(),
    });
    const tool = wrapped ? createOpenClawReadTool(base) : base;
    let actual = "",
      display = "",
      separator = "";
    const result = await runCodeMode(
      {
        ...tool,
        execute: async (...args) => {
          const page = await tool.execute(...args);
          expectContract(tool, page.details);
          const details = page.details;
          if (details.kind !== "text" && details.kind !== "truncated") {
            throw new Error("Expected file text");
          }
          if (!actual && indent !== undefined) {
            expect(JSON.stringify(page.content)).toContain("to continue.");
          }
          const text = page.content.find((block) => block.type === "text")!.text;
          actual += separator + details.content;
          display +=
            separator +
            (details.kind === "truncated" ? text.slice(0, text.lastIndexOf("\n\n[")) : text);
          separator =
            details.kind === "truncated" && details.continuation.kind === "line" ? "\n" : "";
          return page;
        },
      },
      `
        let content = "";
        let next = { path: "records.json", limit: ${limit ?? "undefined"}, offset: ${offset ?? 1} };
        let delimiter = "";
        for (let page = 0; page < 32; page++) {
          const part = await read(next);
          content += delimiter + part.content;
          if (part.kind === "text") {
            const value = JSON.parse(content);
            return { last: Array.isArray(value) ? value.at(-1) : value.generated.length, length: content.length };
          }
          if (part.kind !== "truncated") throw new Error("unexpected read result");
          const { kind, ...continuation } = part.continuation;
          next = { path: "records.json", ...continuation };
          delimiter = kind === "line" ? "\\n" : "";
        }
        throw new Error("pagination did not reach EOF");
      `,
    );
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.value).toEqual({
      last: indent === undefined ? size : records.at(-1),
      length: original.length,
    });
    expect(actual).toBe(original);
    expect(display).toBe(original);
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

it.each([
  {
    name: "retains continuation when its notice exceeds the rebound budget",
    content: "x".repeat(2_000),
    options: { maxBytes: 200 },
    wrapping: { modelContextWindowTokens: 100 },
    args: {},
    details: { continuation: { kind: "cursor", offset: 1, cursor: expect.any(Number) } },
  },
  {
    name: "honors normalized limit 0 without automatic paging",
    content: "alpha\nbeta\ngamma",
    args: { limit: 0 },
    details: { content: "alpha", continuation: { kind: "line", offset: 2, limit: 1 } },
  },
])("$name", async ({ content, options, wrapping, args, details }) => {
  await write("limited.txt", content);
  await expectResult(
    read(options, wrapping),
    { path: "limited.txt", ...args },
    {
      kind: "truncated",
      ...details,
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
});

it("validates the write result schema including optional creation state", async () => {
  const tool = createWriteTool(tmpDir) as unknown as AnyAgentTool;
  await expectResult(
    tool,
    { path: "write.txt", content: "one\n" },
    { changed: true, created: true },
  );
  expectContract(tool, { changed: true });
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
});
