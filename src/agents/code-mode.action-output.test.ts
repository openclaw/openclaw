import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeModeToolApiFile } from "./code-mode-tool-api.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { defineToolOutputSchema } from "./schema/tool-output-schema.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

it("infers literal and union selectors while keeping dynamic and missing inputs sound", async () => {
  const h = createCodeModeHarness();
  const tool = pluginToolWithExecute("records", "Read records or status", async (_id, input) =>
    jsonResult(isRecord(input) && input.kind === "list" ? { rows: ["one", "two"] } : { total: 2 }),
  );
  tool.parameters = Type.Object(
    { kind: Type.Optional(Type.String()) },
    { additionalProperties: false },
  );
  tool.outputSchema = defineToolOutputSchema({
    inputProperty: "kind",
    variants: {
      list: Type.Object({ rows: Type.Array(Type.String()) }, { additionalProperties: false }),
      status: Type.Object({ total: Type.Number() }, { additionalProperties: false }),
    },
  });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
  const exec = expectDefined(h.tools[0], "Code Mode exec");
  const result = resultDetails(
    await exec.execute("literal-and-union", {
      language: "typescript",
      typecheck: true,
      code: `
      const list = await records({kind: "list"});
      const status = await records({kind: "status"});
      const choice: "list" | "status" = Math.random() > 0.5 ? "list" : "status";
      const selected = await records({kind: choice});
      const selectedCount: number = "rows" in selected ? selected.rows.length : selected.total;
      const dynamic: string = "status";
      const broad = await records({kind: dynamic});
      const omitted = await records();
      const broadCount: number = "rows" in broad ? broad.rows.length : broad.total;
      const omittedCount: number = "rows" in omitted ? omitted.rows.length : omitted.total;
      const explicit = await records(undefined);
      const explicitCount: number = "rows" in explicit ? explicit.rows.length : explicit.total;
      return [list.rows.length, status.total, selectedCount, broadCount, omittedCount, explicitCount];
    `,
    }),
  );
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "completed",
    value: [2, 2, 2, 2, 2, 2],
  });
  vi.mocked(tool.execute).mockClear();
  for (const code of [
    'const result = await records({kind:"list"}); return result.total;',
    'const kind: string = "list"; const result = await records({kind}); return result.rows;',
    'const kind: "list" | "status" = Math.random() > 0.5 ? "list" : "status"; const result = await records({kind}); return result.rows;',
    "const result = await records(); return result.rows;",
  ]) {
    const refused = resultDetails(
      await exec.execute("invalid-selection", { language: "typescript", typecheck: true, code }),
    );
    expect(refused).toMatchObject({
      status: "failed",
      code: "invalid_input",
      error: expect.stringContaining("does not exist"),
    });
  }
  expect(tool.execute).not.toHaveBeenCalled();
  const omittedGeneric = resultDetails(
    await exec.execute("omitted-generic", {
      language: "typescript",
      typecheck: true,
      code: 'const result = await records<{kind:"list"}>(); return result.rows.length;',
    }),
  );
  expect(omittedGeneric).toMatchObject({
    status: "failed",
    code: "invalid_input",
    error: expect.stringContaining("Expected 1 arguments"),
  });
  expect(tool.execute).not.toHaveBeenCalled();
});

it("keeps a large set of action declarations within the complete output allowance", async () => {
  const fields = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`field_${index}_${"x".repeat(75)}`, Type.String()]),
  );
  const variants = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `action_${index}`,
      Type.Object({ ...fields, tag: Type.Literal(index) }, { additionalProperties: false }),
    ]),
  );
  const file = await createCodeModeToolApiFile("bounded_records", {
    source: "openclaw",
    parameters: Type.Object({ kind: Type.String() }),
    outputSchema: defineToolOutputSchema({ inputProperty: "kind", variants }),
  });
  expect(file.content.length).toBeLessThan(34_000);
  expect(file.content).toContain("Promise<unknown>");
});
