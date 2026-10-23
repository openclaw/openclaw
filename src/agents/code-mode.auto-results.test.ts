import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { typeCheckSources } from "../../test/helpers/typescript.js";
import { createCodeModeToolApiFile } from "./code-mode-tool-api.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  resultText,
  expectCodeModeSharedBudget,
  codeModeRunner,
  createCatalogCodeModeHarness,
  jsonTool,
  expectCompleted,
} from "./code-mode.test-support.js";
import { defineToolOutputSchema } from "./schema/tool-output-schema.js";
import { resolveToolResultBudget, toolResultFitsBudget } from "./tool-result-limits.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

const catalogs: Array<ReturnType<typeof createCatalogCodeModeHarness>["ctx"]> = [];
afterEach(async () => {
  for (const ctx of catalogs.splice(0)) {
    clearToolSearchCatalog(ctx);
  }
  await resetCodeModeTestState();
});

function createResultsHarness(
  options?: Parameters<typeof createCatalogCodeModeHarness>[1],
  modelContextWindowTokens?: number,
) {
  const h = createCatalogCodeModeHarness([], { ...options, modelContextWindowTokens });
  catalogs.push(h.ctx);
  return h;
}

function expectUnretained(output: Record<string, unknown>, reason: string) {
  expectCompleted(output, { truncated: true, guidance: expect.stringContaining(reason) });
  expect(output.value).not.toHaveProperty("reference");
}

const closedObject = (properties: Parameters<typeof Type.Object>[0]) =>
  Type.Object(properties, { additionalProperties: false });

function actionApi(
  variants: Parameters<typeof defineToolOutputSchema>[0]["variants"],
  name = "records",
) {
  return createCodeModeToolApiFile(name, {
    source: "openclaw",
    parameters: Type.Object({ kind: Type.String() }),
    outputSchema: defineToolOutputSchema({ inputProperty: "kind", variants }),
  });
}

it("keeps a usable network reference after output exhaustion and wait", async () => {
  const cap = 1024;
  const context = 4096;
  const { ctx, tools, run, execute } = createResultsHarness(
    { codeMode: { maxOutputBytes: cap } },
    context,
  );
  const rows = Array.from({ length: 180 }, (_, id) => ({ id, title: "row 🦞", amount: 4 }));
  const read = jsonTool("read_rows", rows);
  read.resultContentSource = "network";
  applyCodeModeCatalog({ ...ctx, tools: [...tools, read] });
  const first = await run(
    'const rows = await read_rows({}); text("progress".repeat(500)); await yield_control(); return rows;',
  );
  expect(first.status).toBe("waiting");
  const response = await tools[1]!.execute("finish", { runId: first.runId });
  const saved = resultDetails(response);
  expectCodeModeSharedBudget(saved, cap);
  expectCompleted(saved, {
    truncated: true,
    reference: {
      id: expect.any(String),
      bytes: Buffer.byteLength(JSON.stringify(rows)),
      count: 180,
    },
    guidance: expect.stringContaining("results.load"),
  });
  const id = (saved.value as { reference: { id: string } }).reference.id;
  const loaded = await execute(
    `return (await results.load(${JSON.stringify(id)})).reduce((sum,row) => sum + row.amount,0);`,
    "load",
  );
  expectCompleted(resultDetails(loaded), 720);
  expect(toolResultFitsBudget(resultText(response), resolveToolResultBudget(context))).toBe(true);
  for (const result of [response, loaded]) {
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
  }
  expect(read.execute).toHaveBeenCalledOnce();
});

it("keeps success and old references when automatic retention is full", async () => {
  const { run } = createResultsHarness({ codeMode: { maxOutputBytes: 1024 } });
  const first = await run(
    "let first; for(let i=0;i<64;i++) { const ref = await results.save(i); first ??= ref.id; } return first;",
  );
  expect(first.status).toBe("completed");
  const full = await run(
    'return Array.from({length:180},(_,id) => ({id, description:"data".repeat(10)}));',
  );
  expectUnretained(full, "Not retained: result-store capacity");
  expect(full).not.toHaveProperty("error");
  expectCompleted(await run(`return await results.load(${JSON.stringify(first.value)});`), 0);
});

it.each([
  ["byte allowance", 1024, undefined, 1024, false, "data allowance"],
  ["complete capture with model budget", 65536, 4096, 1024, false, "data allowance"],
  ["restart-safe", 1024, undefined, 10485760, true, "restart-safe"],
] as const)(
  "returns successful truncation for %s",
  async (_name, bytes, context, snapshot, restartSafe, guidance) => {
    const { run } = createResultsHarness(
      { codeMode: { maxOutputBytes: bytes, maxSnapshotBytes: snapshot } },
      context,
    );
    const output = await run(
      'return {rows:Array.from({length:180}, (_,id) => ({id,payload:"🦞".repeat(10)}))};',
      "large",
      { restartSafe },
    );
    expectUnretained(output, guidance);
    expect(output).not.toHaveProperty("error");
  },
);

it("shows nested array counts and explicitly sampled heterogeneous shapes", async () => {
  const { run } = createResultsHarness();
  const output =
    await run(`const rows = Array.from({length:180},(_,id) => ({id, amount:4})); rows[90] = "pending"; rows[179] = null;
      return await results.save({content:[{type:"text",text:"metadata".repeat(1000)}],structuredContent:{rows},isError:false,status:"partial"});`);
  expectCompleted(output, {
    count: 4,
    shape: expect.stringMatching(
      /structuredContent\.rows: 180 items, sampled 3\/180 heterogeneous/,
    ),
    preview: expect.stringContaining('"path":"$.structuredContent.rows"'),
    previewTruncated: true,
  });
  const value = output.value as { shape: string; preview: string };
  expect(value.shape).toContain("string");
  expect(value.shape).toContain("null");
  expect(value.preview).toContain('"sampled":true');
  expect(value.preview).toContain('"isError":false');
});

it("releases an automatic save when a tiny model budget cannot expose its identity", async () => {
  const { ctx, run } = createResultsHarness({ codeMode: { maxOutputBytes: 1024 } }, 1024);
  const output = await run(
    'text("progress".repeat(1000)); return Array.from({length:180},(_,id) => ({id,amount:4}));',
  );
  expectUnretained(output, "Not retained: reference exceeds output budget");
  const ordinary = codeModeRunner(
    createCodeModeTools({ ...ctx, modelContextWindowTokens: undefined }),
  );
  expectCompleted(
    await ordinary.run("for(let i=0;i<64;i++) await results.save(i); return 64;", "capacity"),
    64,
  );
});

it("bounds deep and long-key preview traversal", async () => {
  const { run } = createResultsHarness();
  const output = await run(
    `const root = { ["x".repeat(10000)]: [77] }; let next = root; for(let i=0;i<20;i++) {next.deep={};next=next.deep;} next.hidden=[99]; return await results.save(root);`,
  );
  expectCompleted(output, {
    id: expect.any(String),
    shape: expect.stringContaining("limited traversal"),
    preview: expect.stringContaining('"traversalLimited":true'),
    previewTruncated: true,
  });
  expect(Buffer.byteLength(JSON.stringify(output.value))).toBeLessThanOrEqual(768);
  const id = (output.value as { id: string }).id;
  expectCompleted(
    await run(
      `const value = await results.load(${JSON.stringify(id)}); return value["x".repeat(10000)][0];`,
    ),
    77,
  );
});

it("infers literal and union selectors while keeping dynamic and missing inputs sound", async () => {
  const tool = pluginToolWithExecute("records", "Read records or status", async (_id, input) =>
    jsonResult(isRecord(input) && input.kind === "list" ? { rows: ["one", "two"] } : { total: 2 }),
  );
  tool.parameters = closedObject({ kind: Type.Optional(Type.String()) });
  tool.outputSchema = defineToolOutputSchema({
    inputProperty: "kind",
    variants: {
      list: closedObject({ rows: Type.Array(Type.String()) }),
      status: closedObject({ total: Type.Number() }),
    },
  });
  const { run } = createCatalogCodeModeHarness([tool]);
  const declaration = await run(
    'return await API.read("tools/records.d.ts");',
    "read-records-contract",
  );
  expect(declaration.status).toBe("completed");
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
  const source = `${(declaration.value as { content: string }).content}
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
}`;
  expect(typeCheckSources({ "/records-consumer.ts": source })).toEqual([]);
  expect(tool.execute).not.toHaveBeenCalled();

  expectCompleted(await run(composition, "literal-and-union"), [2, 2, 2, 2, 2, 2]);
  expect(tool.execute).toHaveBeenCalledTimes(6);
});

it("keeps a large set of action declarations within the complete output allowance", async () => {
  const fields = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`field_${index}_${"x".repeat(75)}`, Type.String()]),
  );
  const variants = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `action_${index}`,
      closedObject({ ...fields, tag: Type.Literal(index) }),
    ]),
  );
  const file = await actionApi(variants, "bounded_records");
  expect(file.content.length).toBeLessThan(34_000);
  expect(file.content).toContain("Promise<unknown>");
});

it("preserves changed fields, requiredness, and root constraints when reusing object declarations", async () => {
  const base = closedObject({ value: Type.String() });
  const extended = closedObject({ ...base.properties, receipt: Type.String() });
  const file = await actionApi({
    empty: closedObject({}),
    base,
    extended,
    changed: closedObject({ ...extended.properties, value: Type.Number() }),
    optional: { ...extended, required: ["receipt"] },
    constrained: { ...extended, allOf: [{ maxProperties: 1 }] },
  });
  expect(
    typeCheckSources({
      "/extended-records.ts": `${file.content}
async function consume() {
  const extended = await records({ kind: "extended" });
  const accepted: typeof extended = { value: "item", receipt: "approved" };
  const value: string = extended.value;
  const receipt: string = extended.receipt;
  const changed = await records({ kind: "changed" });
  const numeric: number = changed.value;
  const optional = await records({ kind: "optional" });
  const maybe: string | undefined = optional.value;
  // @ts-expect-error Reuse must not restore requiredness removed by this branch.
  const required: string = optional.value;
  const constrained = await records({ kind: "constrained" });
  // @ts-expect-error Unsupported root constraints must retain an unknown result.
  constrained.receipt;
}`,
    }),
  ).toEqual([]);
});

it("bounds inspection and repeated console output under the shared result cap", async () => {
  const maxOutputBytes = 65_536;
  const result = await runCodeModeScriptHeadless({
    ctx: createHeadlessCodeModeHarness([], { codeMode: { maxOutputBytes } }),
    code:
      'const huge = { unicode: "🦞".repeat(100000), values: Array(100000).fill("x") }; ' +
      'console.log(huge); console.error(new Proxy({}, { ownKeys() { throw Error("bad proxy"); } })); ' +
      "for (let i = 0; i < 20000; i++) console.log(); await yield_control(); " +
      'console.log("after exhaustion"); return true;',
  });
  expect(result.status).toBe("completed");
  expectCodeModeSharedBudget(result, maxOutputBytes);
  expect(JSON.stringify(result.output)).toContain("🦞");
  expect(result.output.length).toBeLessThan(700);
  expect(
    result.output.filter(
      (entry) =>
        isRecord(entry) && entry.type === "text" && entry.text === "[console output truncated]",
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(result.output)).not.toContain("after exhaustion");
  expect(JSON.stringify(result.output)).toContain("[Unserializable]");
});
