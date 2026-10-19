import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { asSource, seedFile } from "./agent-tools.mutation.test-support.js";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createWriteTool } from "./sessions/tools/index.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const RELATIVE_PATH = "memory/2026-08-08.md";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let declaredWriteOutputSchema: JsonSchemaObject;

let root: string;
let baseTool: AnyAgentTool;
const absolute = () => path.join(root, RELATIVE_PATH);
const read = () => fs.readFile(absolute(), "utf8");
const seed = (content: string) => seedFile(absolute(), content);
function wrap(options: Partial<Parameters<typeof wrapToolMemoryFlushAppendOnlyWrite>[1]> = {}) {
  return wrapToolMemoryFlushAppendOnlyWrite(baseTool, {
    root,
    relativePath: RELATIVE_PATH,
    ...options,
  });
}
const write = (tool: AnyAgentTool, content: string, filePath = RELATIVE_PATH) =>
  tool.execute("write", { path: filePath, content });

beforeEach(() => {
  root = tempDirs.make("memory-flush-write-");
  // Mirror the catalog's serialized public schema, not a private test export.
  const declaredWriteTool = createWriteTool(root);
  const outputSchema = declaredWriteTool.outputSchema;
  if (!isRecord(outputSchema)) {
    throw new Error("The public write tool must declare an object output schema");
  }
  declaredWriteOutputSchema = structuredClone(outputSchema);
  baseTool = { ...declaredWriteTool, outputSchema: declaredWriteOutputSchema };
  vi.spyOn(baseTool, "execute").mockRejectedValue(
    new Error("append-only wrapper must not delegate"),
  );
});

describe.each(["host", "sandbox"] as const)("%s append", (backend) => {
  const saved =
    "# Daily notes\n\n- Project Alder uses port 7319.\n\n## Deployment\nUse staging first.\n\n---\n";
  const added = "- Project Birch uses port 8421.\n";
  const backendTool = () =>
    wrap({
      sandbox:
        backend === "sandbox" ? { root, bridge: createHostSandboxFsBridge(root) } : undefined,
    });

  it.each([
    ["whole note", saved, saved + added],
    ["whole note without trailing newline", saved.trimEnd(), saved + added],
    ["interior read window", saved, "## Deployment\nUse staging first.\n\n" + added],
    ["copied fact", saved, "- Project Alder uses port 7319.\n\n" + added],
    ["prefix without separator", saved, "- Project Alder uses port 7319.\n" + added],
    ["Windows note", saved.replaceAll("\n", "\r\n"), saved + added],
    ["retry of saved note", saved, saved],
  ])("rejects %s, then accepts a delta", async (_name, existing, content) => {
    await seed(existing);
    const tool = backendTool();
    await expect(write(tool, content)).rejects.toThrow("Retry with only new content");
    expect(await read()).toBe(existing);
    await write(tool, added);
    expect(await read()).toBe(existing + (existing.endsWith("\n") ? "" : "\n") + added);
  });

  it("creates a note and permits repeated headings with new facts", async () => {
    const tool = backendTool();
    await write(tool, saved);
    const content = "# Daily notes\n\n---\n\n## Deployment\nUse port 8421 for Birch.\n";
    await write(tool, content);
    expect(await read()).toBe(saved + content);
  });
});

it("rechecks source authority after provenance work before appending", async () => {
  await seed("seed\n");
  const originalClaim = {};
  let claim = originalClaim;
  let reachedCommit = false;
  const wrapped = wrap({
    memoryWriteProvenance: {
      classifies: async () => true,
      write: async ({ commit }) => {
        reachedCommit = true;
        claim = {};
        await commit();
      },
      clearAfterDelete: async () => {},
    },
  });
  const pending = asSource(
    "memory-flush-authority",
    () => claim === originalClaim,
    () => write(wrapped, "hello"),
  );
  await expect(pending).rejects.toThrow("authority is no longer active");
  expect(reachedCommit).toBe(true);
  expect(await read()).toBe("seed\n");
});

it("returns the write schema only for the allowed file", async () => {
  await seed("seed");
  const wrapped = wrap();
  const result = await write(wrapped, "hello");
  expect(result).toEqual({
    content: [{ type: "text", text: `Appended content to ${RELATIVE_PATH}.` }],
    details: { changed: true },
  });
  const validation = validateJsonSchemaValue({
    schema: declaredWriteOutputSchema,
    cacheKey: "test:memory-flush-write-output",
    value: result.details,
    cache: false,
  });
  expect(validation.ok).toBe(true);
  expect(await read()).toBe("seed\nhello");
  await expect(write(wrapped, "wrong target", "memory/other-day.md")).rejects.toThrow(
    `Memory flush writes are restricted to ${RELATIVE_PATH}; use that path only.`,
  );
  expect(baseTool.execute).not.toHaveBeenCalled();
});

it.each(["file", "absent"] as const)(
  "rejects @memory without touching its sibling (literal: %s)",
  async (literalState) => {
    const literalPath = path.join(root, `@${RELATIVE_PATH}`);
    await seed("allowed");
    if (literalState === "file") {
      await fs.mkdir(path.dirname(literalPath), { recursive: true });
      await fs.writeFile(literalPath, "literal", "utf8");
    }
    const wrapped = wrap();

    await expect(write(wrapped, "wrong journal", `@${RELATIVE_PATH}`)).rejects.toThrow(
      /Memory flush writes are restricted/,
    );
    await expect(read()).resolves.toBe("allowed");
    if (literalState === "file") {
      await expect(fs.readFile(literalPath, "utf8")).resolves.toBe("literal");
    }
  },
);
