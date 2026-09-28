import { afterEach, expect, it } from "vitest";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  expectCodeModeSharedBudget,
} from "./code-mode.test-support.js";
import { resolveToolResultBudget, toolResultFitsBudget } from "./tool-result-limits.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

it.each([
  { modelContextWindowTokens: undefined, maxOutputBytes: 1024, network: false },
  { modelContextWindowTokens: 2048, maxOutputBytes: 65536, network: false },
  { modelContextWindowTokens: 4096, maxOutputBytes: 1024, network: true },
])(
  "keeps a usable automatic reference after output exhaustion and wait (context=$modelContextWindowTokens, bytes=$maxOutputBytes, network=$network)",
  async ({ modelContextWindowTokens, maxOutputBytes, network }) => {
    const h = createCodeModeHarness({ codeMode: { maxOutputBytes } });
    const ctx = { ...h.ctx, modelContextWindowTokens };
    const tools = createCodeModeTools(ctx);
    const rows = Array.from({ length: 180 }, (_, id) => ({ id, title: "row 🦞", amount: 4 }));
    const read = pluginToolWithExecute("read_rows", "Rows", async () => jsonResult(rows));
    if (network) {
      read.resultContentSource = "network";
    }
    applyCodeModeCatalog({ ...ctx, tools: [...tools, read] });
    try {
      const first = resultDetails(
        await tools[0]!.execute("emit", {
          code: 'const rows = await read_rows({}); text("progress".repeat(500)); await yield_control(); return rows;',
        }),
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
      if (modelContextWindowTokens) {
        const text = response.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        expect(toolResultFitsBudget(text, resolveToolResultBudget(modelContextWindowTokens))).toBe(
          true,
        );
      }
      if (network) {
        expect(response.content[0]).toMatchObject({
          text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
        });
        expect(loaded.content[0]).toMatchObject({
          text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
        });
      }
      expect(read.execute).toHaveBeenCalledOnce();
    } finally {
      clearToolSearchCatalog(ctx);
    }
  },
);

it("keeps success and old references when automatic retention is full", async () => {
  const { ctx, tools } = createCodeModeHarness({ codeMode: { maxOutputBytes: 1024 } });
  applyCodeModeCatalog({ ...ctx, tools });
  try {
    const first = resultDetails(
      await tools[0]!.execute("fill", {
        code: "let first; for(let i=0;i<64;i++) { const ref = await results.save(i); first ??= ref.id; } return first;",
      }),
    );
    expect(first.status).toBe("completed");
    const full = resultDetails(
      await tools[0]!.execute("oversized", {
        code: 'return Array.from({length:180},(_,id) => ({id, description:"data".repeat(10)}));',
      }),
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
    expect(
      resultDetails(
        await tools[0]!.execute("old", {
          code: `return await results.load(${JSON.stringify(first.value)});`,
        }),
      ),
    ).toMatchObject({ status: "completed", value: 0 });
  } finally {
    clearToolSearchCatalog(ctx);
  }
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
    const h = createCodeModeHarness({ codeMode: { maxOutputBytes, maxSnapshotBytes } });
    const ctx = { ...h.ctx, modelContextWindowTokens };
    const tools = createCodeModeTools(ctx);
    applyCodeModeCatalog({ ...ctx, tools });
    try {
      const output = resultDetails(
        await tools[0]!.execute("large", {
          restartSafe,
          code: 'return {rows:Array.from({length:180}, (_,id) => ({id,payload:"🦞".repeat(10)}))};',
        }),
      );
      expect(output).toMatchObject({
        status: "completed",
        value: { truncated: true, guidance: expect.stringContaining(guidance) },
      });
      expect(output.value).not.toHaveProperty("reference");
      expect(output).not.toHaveProperty("error");
    } finally {
      clearToolSearchCatalog(ctx);
    }
  },
);

it("shows nested array counts and explicitly sampled heterogeneous shapes", async () => {
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
  try {
    const output = resultDetails(
      await h.tools[0]!.execute("preview", {
        code: `const rows = Array.from({length:180},(_,id) => ({id, amount:4})); rows[90] = "pending"; rows[179] = null;
      return await results.save({content:[{type:"text",text:"metadata".repeat(1000)}],structuredContent:{rows},isError:false,status:"partial"});`,
      }),
    );
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
  } finally {
    clearToolSearchCatalog(h.ctx);
  }
});

it("releases an automatic save when a tiny model budget cannot expose its identity", async () => {
  const { ctx } = createCodeModeHarness({ codeMode: { maxOutputBytes: 1024 } });
  const tools = createCodeModeTools({ ...ctx, modelContextWindowTokens: 1024 });
  applyCodeModeCatalog({ ...ctx, tools });
  try {
    const output = resultDetails(
      await tools[0]!.execute("tiny", {
        code: 'text("progress".repeat(1000)); return Array.from({length:180},(_,id) => ({id,amount:4}));',
      }),
    );
    expect(output, JSON.stringify(output)).toMatchObject({
      status: "completed",
      value: {
        truncated: true,
        guidance: expect.stringContaining("Not retained: reference exceeds output budget"),
      },
    });
    expect(output.value).not.toHaveProperty("reference");
    const ordinary = createCodeModeTools(ctx);
    expect(
      resultDetails(
        await ordinary[0]!.execute("capacity", {
          code: "for(let i=0;i<64;i++) await results.save(i); return 64;",
        }),
      ),
    ).toMatchObject({ status: "completed", value: 64 });
  } finally {
    clearToolSearchCatalog(ctx);
  }
});

it.each([true, false])(
  "bounds deep and long-key preview traversal (visible array=%s)",
  async (visibleArray) => {
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
    try {
      const output = resultDetails(
        await h.tools[0]!.execute("bounded-preview", {
          code: `const root = { ${visibleArray ? "rows: Array.from({length:20},(_,id) => ({id}))," : ""} ["x".repeat(10000)]: [77] }; let next = root; for(let i=0;i<20;i++) {next.deep={};next=next.deep;} next.hidden=[99]; return await results.save(root);`,
        }),
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
        resultDetails(
          await h.tools[0]!.execute("full", {
            code: `const value = await results.load(${JSON.stringify(id)}); return value["x".repeat(10000)][0];`,
          }),
        ),
      ).toMatchObject({ status: "completed", value: 77 });
    } finally {
      clearToolSearchCatalog(h.ctx);
    }
  },
);

it("preserves complete UTF-8 JSON above the output allowance but within the data allowance", async () => {
  const { ctx, tools } = createCodeModeHarness({
    codeMode: { maxOutputBytes: 1024, maxSnapshotBytes: 2048 },
  });
  applyCodeModeCatalog({ ...ctx, tools });
  try {
    const output = resultDetails(
      await tools[0]!.execute("unicode", { code: 'return ["🦞".repeat(260)];' }),
    );
    expect(output).toMatchObject({
      status: "completed",
      value: { reference: { id: expect.any(String), bytes: 1044, count: 1 } },
    });
    const id = (output.value as { reference: { id: string } }).reference.id;
    expect(
      resultDetails(
        await tools[0]!.execute("length", {
          code: `return (await results.load(${JSON.stringify(id)}))[0].length;`,
        }),
      ),
    ).toMatchObject({ status: "completed", value: 520 });
  } finally {
    clearToolSearchCatalog(ctx);
  }
});
