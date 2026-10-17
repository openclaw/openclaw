import { expectDefined } from "@openclaw/normalization-core";
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
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  expectCodeModeSharedBudget,
} from "./code-mode.test-support.js";
import { defineToolOutputSchema } from "./schema/tool-output-schema.js";
import { resolveToolResultBudget, toolResultFitsBudget } from "./tool-result-limits.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

const catalogs: Array<ReturnType<typeof createCodeModeHarness>["ctx"]> = [];
afterEach(async () => {
  for (const ctx of catalogs.splice(0)) {
    clearToolSearchCatalog(ctx);
  }
  await resetCodeModeTestState();
});

function createResultsHarness(
  options?: Parameters<typeof createCodeModeHarness>[0],
  modelContextWindowTokens?: number,
) {
  const h = createCodeModeHarness(options);
  const ctx = { ...h.ctx, modelContextWindowTokens };
  const tools = createCodeModeTools(ctx);
  catalogs.push(ctx);
  applyCodeModeCatalog({ ...ctx, tools });
  return {
    ctx,
    tools,
    run: async (code: string, args: { restartSafe?: boolean } = {}) =>
      resultDetails(await tools[0]!.execute("result", { code, ...args })),
  };
}

it("keeps a usable network reference after output exhaustion and wait", async () => {
  const maxOutputBytes = 1024;
  const modelContextWindowTokens = 4096;
  const { ctx, tools, run } = createResultsHarness(
    { codeMode: { maxOutputBytes } },
    modelContextWindowTokens,
  );
  const rows = Array.from({ length: 180 }, (_, id) => ({ id, title: "row 🦞", amount: 4 }));
  const read = pluginToolWithExecute("read_rows", "Rows", async () => jsonResult(rows));
  read.resultContentSource = "network";
  applyCodeModeCatalog({ ...ctx, tools: [...tools, read] });
  const first = await run(
    'const rows = await read_rows({}); text("progress".repeat(500)); await yield_control(); return rows;',
  );
  expect(first.status).toBe("waiting");
  const response = await tools[1]!.execute("finish", { runId: first.runId });
  const saved = resultDetails(response);
  expectCodeModeSharedBudget(saved, maxOutputBytes);
  expect(saved, JSON.stringify(saved)).toMatchObject({
    status: "completed",
    value: {
      truncated: true,
      reference: {
        id: expect.any(String),
        bytes: Buffer.byteLength(JSON.stringify(rows)),
        count: 180,
      },
      guidance: expect.stringContaining("results.load"),
    },
  });
  const id = (saved.value as { reference: { id: string } }).reference.id;
  const loaded = await tools[0]!.execute("load", {
    code: `return (await results.load(${JSON.stringify(id)})).reduce((sum,row) => sum + row.amount,0);`,
  });
  expect(resultDetails(loaded)).toMatchObject({ status: "completed", value: 720 });
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  expect(toolResultFitsBudget(text, resolveToolResultBudget(modelContextWindowTokens))).toBe(true);
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
  expect(full).toMatchObject({
    status: "completed",
    value: {
      truncated: true,
      guidance: expect.stringContaining("Not retained: result-store capacity"),
    },
  });
  expect(full.value).not.toHaveProperty("reference");
  expect(full).not.toHaveProperty("error");
  expect(await run(`return await results.load(${JSON.stringify(first.value)});`)).toMatchObject({
    status: "completed",
    value: 0,
  });
});

it.each([
  {
    name: "retention byte allowance",
    maxOutputBytes: 1024,
    modelContextWindowTokens: undefined,
    maxSnapshotBytes: 1024,
    restartSafe: false,
    guidance: "data allowance",
  },
  {
    name: "retention allowance below complete capture and model budget",
    maxOutputBytes: 65536,
    modelContextWindowTokens: 4096,
    maxSnapshotBytes: 1024,
    restartSafe: false,
    guidance: "data allowance",
  },
  {
    name: "restart-safe execution",
    maxOutputBytes: 1024,
    modelContextWindowTokens: undefined,
    maxSnapshotBytes: 10485760,
    restartSafe: true,
    guidance: "restart-safe",
  },
])(
  "returns an ordinary successful truncation for $name",
  async ({ maxOutputBytes, modelContextWindowTokens, maxSnapshotBytes, restartSafe, guidance }) => {
    const { run } = createResultsHarness(
      { codeMode: { maxOutputBytes, maxSnapshotBytes } },
      modelContextWindowTokens,
    );
    const output = await run(
      'return {rows:Array.from({length:180}, (_,id) => ({id,payload:"🦞".repeat(10)}))};',
      { restartSafe },
    );
    expect(output).toMatchObject({
      status: "completed",
      value: { truncated: true, guidance: expect.stringContaining(guidance) },
    });
    expect(output.value).not.toHaveProperty("reference");
    expect(output).not.toHaveProperty("error");
  },
);

it("shows nested array counts and explicitly sampled heterogeneous shapes", async () => {
  const { run } = createResultsHarness();
  const output =
    await run(`const rows = Array.from({length:180},(_,id) => ({id, amount:4})); rows[90] = "pending"; rows[179] = null;
      return await results.save({content:[{type:"text",text:"metadata".repeat(1000)}],structuredContent:{rows},isError:false,status:"partial"});`);
  expect(output).toMatchObject({
    status: "completed",
    value: {
      count: 4,
      shape: expect.stringMatching(
        /structuredContent\.rows: 180 items, sampled 3\/180 heterogeneous/,
      ),
      preview: expect.stringContaining('"path":"$.structuredContent.rows"'),
      previewTruncated: true,
    },
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
  expect(output, JSON.stringify(output)).toMatchObject({
    status: "completed",
    value: {
      truncated: true,
      guidance: expect.stringContaining("Not retained: reference exceeds output budget"),
    },
  });
  expect(output.value).not.toHaveProperty("reference");
  const ordinary = createCodeModeTools({ ...ctx, modelContextWindowTokens: undefined });
  expect(
    resultDetails(
      await ordinary[0]!.execute("capacity", {
        code: "for(let i=0;i<64;i++) await results.save(i); return 64;",
      }),
    ),
  ).toMatchObject({ status: "completed", value: 64 });
});

it("bounds deep and long-key preview traversal", async () => {
  const { run } = createResultsHarness();
  const output = await run(
    `const root = { ["x".repeat(10000)]: [77] }; let next = root; for(let i=0;i<20;i++) {next.deep={};next=next.deep;} next.hidden=[99]; return await results.save(root);`,
  );
  expect(output).toMatchObject({
    status: "completed",
    value: {
      id: expect.any(String),
      shape: expect.stringContaining("limited traversal"),
      preview: expect.stringContaining('"traversalLimited":true'),
      previewTruncated: true,
    },
  });
  expect(Buffer.byteLength(JSON.stringify(output.value))).toBeLessThanOrEqual(768);
  const id = (output.value as { id: string }).id;
  expect(
    await run(
      `const value = await results.load(${JSON.stringify(id)}); return value["x".repeat(10000)][0];`,
    ),
  ).toMatchObject({ status: "completed", value: 77 });
});

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
  const source = `${file.content}
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
  expect(typeCheckSources({ [fileName]: source })).toEqual([]);
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

it("bounds inspection and repeated console output under the shared result cap", async () => {
  const maxOutputBytes = 65_536;
  const result = await runCodeModeScriptHeadless({
    ctx: createHeadlessCodeModeHarness(),
    code:
      'const huge = { unicode: "🦞".repeat(100000), values: Array(100000).fill("x") }; ' +
      'console.log(huge); console.error(new Proxy({}, { ownKeys() { throw Error("bad proxy"); } })); ' +
      "for (let i = 0; i < 20000; i++) console.log(); await yield_control(); " +
      'console.log("after exhaustion"); return true;',
    overrides: { maxOutputBytes },
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
