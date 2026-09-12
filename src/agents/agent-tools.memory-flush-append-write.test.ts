import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createWriteTool } from "./sessions/tools/index.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const RELATIVE_PATH = "memory/2026-08-08.md";

let declaredWriteTool: ReturnType<typeof createWriteTool>;
let declaredWriteOutputSchema: JsonSchemaObject;

function baseWriteTool(): AnyAgentTool {
  return {
    ...declaredWriteTool,
    outputSchema: declaredWriteOutputSchema,
    execute: vi.fn(async () => {
      throw new Error("append-only wrapper should not delegate for append params");
    }),
  };
}

function validateAgainstDeclaredSchema(value: unknown) {
  return validateJsonSchemaValue({
    schema: declaredWriteOutputSchema,
    cacheKey: "test:memory-flush-write-output",
    value,
    cache: false,
  });
}

describe("wrapToolMemoryFlushAppendOnlyWrite output contract", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-flush-write-"));
    // Mirror the catalog path: declared schemas are JSON-serialized before the
    // bridge validates results against them. Read the schema from the public
    // tool factory so production internals do not need a test-only export.
    declaredWriteTool = createWriteTool(root);
    const outputSchema = declaredWriteTool.outputSchema;
    if (!isRecord(outputSchema)) {
      throw new Error("The public write tool must declare an object output schema");
    }
    declaredWriteOutputSchema = structuredClone(outputSchema);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function runAppend(): Promise<unknown> {
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });
    const result = await wrapped.execute(
      "call-1",
      { path: RELATIVE_PATH, content: "hello" },
      new AbortController().signal,
      undefined,
    );
    return result.details;
  }

  it.each(["revoked", "replaced", "active"] as const)(
    "checks %s source authority after provenance work before appending",
    async (authority) => {
      const absolute = path.join(root, RELATIVE_PATH);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, "seed\n");
      const originalClaim = {};
      let claim: object | undefined = originalClaim;
      let reachedCommit = false;
      const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
        root,
        relativePath: RELATIVE_PATH,
        memoryWriteProvenance: {
          classifies: async () => true,
          write: async ({ commit }) => {
            reachedCommit = true;
            if (authority === "revoked") {
              claim = undefined;
            }
            if (authority === "replaced") {
              claim = {};
            }
            await commit();
          },
          clearAfterDelete: async () => {},
        },
      });
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:memory-flush-authority",
          receiptAuthority: () => claim === originalClaim,
        },
        () => wrapped.execute("source-append", { path: RELATIVE_PATH, content: "hello" }),
      );
      if (authority === "active") {
        await expect(pending).resolves.toMatchObject({ details: { changed: true } });
      } else {
        await expect(pending).rejects.toThrow("authority is no longer active");
      }
      expect(reachedCommit).toBe(true);
      expect(await fs.readFile(absolute, "utf8")).toBe(
        authority === "active" ? "seed\nhello" : "seed\n",
      );
    },
  );

  it("returns write-schema-conforming details when creating the memory file", async () => {
    const details = await runAppend();
    expect(details).toEqual({ changed: true });
    expect(validateAgainstDeclaredSchema(details).ok).toBe(true);
  });

  it.each(["seed", "seed\n"])(
    "returns write-schema-conforming append results for existing content %j",
    async (seed) => {
      const absolute = path.join(root, RELATIVE_PATH);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, seed, "utf-8");
      const baseTool = baseWriteTool();
      const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseTool, {
        root,
        relativePath: RELATIVE_PATH,
      });
      const result = await wrapped.execute("call-append", {
        path: RELATIVE_PATH,
        content: "hello",
      });
      expect(result).toEqual({
        content: [{ type: "text", text: `Appended content to ${RELATIVE_PATH}.` }],
        details: { changed: true },
      });
      expect(validateAgainstDeclaredSchema(result.details).ok).toBe(true);
      expect(await fs.readFile(absolute, "utf-8")).toBe("seed\nhello");
      await expect(
        wrapped.execute("call-sibling", {
          path: "memory/other-day.md",
          content: "wrong target",
        }),
      ).rejects.toThrow(
        `Memory flush writes are restricted to ${RELATIVE_PATH}; use that path only.`,
      );
      expect(baseTool.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["file", "ancestor", "absent"] as const)(
    "rejects @memory paths instead of appending to their allowed sibling (literal: %s)",
    async (literalState) => {
      const allowedPath = path.join(root, RELATIVE_PATH);
      const literalPath = path.join(root, `@${RELATIVE_PATH}`);
      await fs.mkdir(path.dirname(allowedPath), { recursive: true });
      await fs.writeFile(allowedPath, "allowed", "utf8");
      if (literalState !== "absent") {
        await fs.mkdir(path.dirname(literalPath), { recursive: true });
      }
      if (literalState === "file") {
        await fs.writeFile(literalPath, "literal", "utf8");
      }
      const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
        root,
        relativePath: RELATIVE_PATH,
      });

      await expect(
        wrapped.execute("at-memory-flush", {
          path: `@${RELATIVE_PATH}`,
          content: "wrong journal",
        }),
      ).rejects.toThrow(/Memory flush writes are restricted/);
      await expect(fs.readFile(allowedPath, "utf8")).resolves.toBe("allowed");
      if (literalState === "file") {
        await expect(fs.readFile(literalPath, "utf8")).resolves.toBe("literal");
      }
    },
  );

  it("documents the pre-fix regression: append-only metadata violates the declared schema", () => {
    const validation = validateAgainstDeclaredSchema({ path: RELATIVE_PATH, appendOnly: true });
    expect(validation.ok).toBe(false);
  });
});
