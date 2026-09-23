import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
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
  const declaration = resultDetails(
    await exec.execute("read-records-contract", {
      code: 'return await API.read("tools/records.d.ts");',
    }),
  );
  expect(declaration.status).toBe("completed");
  const file = declaration.value as { content: string };
  const composition = `
    const list = await records({kind: "list"});
    const status = await records({kind: "status"});
    const choice = Math.random() > 0.5 ? "list" : "status";
    const selected = await records({kind: choice});
    const selectedCount = "rows" in selected ? selected.rows.length : selected.total;
    let dynamic = "status";
    const broad = await records({kind: dynamic});
    const omitted = await records();
    const broadCount = "rows" in broad ? broad.rows.length : broad.total;
    const omittedCount = "rows" in omitted ? omitted.rows.length : omitted.total;
    const explicit = await records(undefined);
    const explicitCount = "rows" in explicit ? explicit.rows.length : explicit.total;
    return [list.rows.length, status.total, selectedCount, broadCount, omittedCount, explicitCount];
  `;
  const fileName = "/records-consumer.ts";
  const source = ts.createSourceFile(
    fileName,
    `${file.content}
async function consume() { ${composition} }
async function checkContracts(kind: string, choice: "list" | "status") {
  const list = await records({kind: "list"});
  // @ts-expect-error A list result has rows, not a total.
  list.total;
  const dynamic = await records({kind});
  // @ts-expect-error A broad selector cannot promise rows.
  dynamic.rows;
  const selected = await records({kind: choice});
  // @ts-expect-error A union selector cannot promise rows.
  selected.rows;
  const omitted = await records();
  // @ts-expect-error Missing selectors keep all output branches.
  omitted.rows;
  // @ts-expect-error A generic selector cannot supply an omitted runtime argument.
  await records<{kind: "list"}>();
}`,
    ts.ScriptTarget.ESNext,
    true,
  );
  const options = { noEmit: true, strict: true, types: [], target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => (name === fileName ? source : original(name, ...args));
  const program = ts.createProgram([fileName], options, host);
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
  expect(tool.execute).not.toHaveBeenCalled();

  const result = resultDetails(await exec.execute("literal-and-union", { code: composition }));
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "completed",
    value: [2, 2, 2, 2, 2, 2],
  });
  expect(tool.execute).toHaveBeenCalledTimes(6);
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
