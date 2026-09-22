import { afterEach, expect, it } from "vitest";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import {
  addClientToolsToToolCatalog,
  registerHeadlessToolSearchCatalog,
  restrictToolSearchCatalog,
} from "./tool-search-catalog.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

it("retains a fetched result across cells without refetching or sharing mutable objects", async () => {
  const rows = Array.from({ length: 500 }, (_, id) => ({ id, paid: id % 2 === 0, amount: 4 }));
  const invoices = pluginToolWithExecute("invoices", "Read invoices", async () => jsonResult(rows));
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, invoices] });
  try {
    const saved = resultDetails(
      await h.tools[0]!.execute("save", {
        code: "const value = await invoices({}); const ref = await results.save(value); value[0].amount = 99; return ref;",
      }),
    );
    expect(saved).toMatchObject({
      status: "completed",
      value: {
        id: expect.any(String),
        bytes: Buffer.byteLength(JSON.stringify(rows)),
        count: 500,
        shape: expect.stringContaining("amount"),
        preview: expect.stringContaining('"id":0'),
        previewTruncated: true,
      },
    });
    const id = (saved.value as { id: string }).id;
    const loaded = resultDetails(
      await h.tools[0]!.execute("load", {
        code: `const rows = await results.load(${JSON.stringify(id)}); rows[0].amount = 999; return (await results.load(${JSON.stringify(id)})).filter(row => !row.paid).reduce((total,row) => total + row.amount,0);`,
      }),
    );
    expect(loaded).toMatchObject({ status: "completed", value: 1000 });
    expect(invoices.execute).toHaveBeenCalledOnce();
  } finally {
    clearToolSearchCatalog(h.ctx);
  }
});

it("keeps complete references within a small output budget and frees exact UTF-8 capacity", async () => {
  const base = createCodeModeHarness();
  const config = {
    tools: { codeMode: { enabled: true, maxSnapshotBytes: 1024, maxOutputBytes: 1024 } },
  };
  const ctx = { ...base.ctx, config, runtimeConfig: config };
  const tools = createCodeModeTools(ctx);
  applyCodeModeCatalog({ ...ctx, tools });
  try {
    const saved = resultDetails(
      await tools[0]!.execute("unicode", {
        code: 'return await results.save("🦞".repeat(255));',
      }),
    );
    expect(saved).toMatchObject({
      status: "completed",
      value: {
        id: expect.any(String),
        bytes: 1022,
        count: 1,
        shape: "string",
        previewTruncated: true,
      },
    });
    const id = (saved.value as { id: string }).id;
    const result = resultDetails(
      await tools[0]!.execute("capacity", {
        code: `let overflow; try { await results.save(123); } catch (error) { overflow = error.message; }
      const length = (await results.load(${JSON.stringify(id)})).length;
      await results.delete(${JSON.stringify(id)});
      const replacement = await results.save("🦞".repeat(255));
      return {overflow,length,bytes:replacement.bytes};`,
      }),
    );
    expect(result).toMatchObject({
      status: "completed",
      value: {
        overflow: expect.stringContaining("results capacity exceeded"),
        length: 510,
        bytes: 1022,
      },
    });
    expect(
      resultDetails(
        await tools[0]!.execute("deleted", {
          code: `return await results.load(${JSON.stringify(id)});`,
        }),
      ),
    ).toMatchObject({ status: "failed", error: expect.stringContaining("unavailable or expired") });
  } finally {
    clearToolSearchCatalog(ctx);
  }
});

it("caps entry count, preserves earlier values, and accepts saves after deletion", async () => {
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
  try {
    const result = resultDetails(
      await h.tools[0]!.execute("count-capacity", {
        code: `const refs = []; for (let i = 0; i < 64; i++) refs.push(await results.save(i));
      let overflow; try { await results.save(65); } catch (error) { overflow = error.message; }
      const first = await results.load(refs[0].id);
      await results.delete(refs[1].id);
      const replacement = await results.save({ok:true});
      return {overflow,first, replacement:await results.load(replacement.id)};`,
      }),
    );
    expect(result).toMatchObject({
      status: "completed",
      value: {
        overflow: expect.stringContaining("results capacity exceeded"),
        first: 0,
        replacement: { ok: true },
      },
    });
  } finally {
    clearToolSearchCatalog(h.ctx);
  }
});

it.each(["replacement", "restriction", "clear", "abort", "run", "session"] as const)(
  "rejects saved data after %s invalidation",
  async (transition) => {
    const h = createCodeModeHarness();
    const abort = new AbortController();
    const ctx = { ...h.ctx, abortSignal: abort.signal };
    const tools = createCodeModeTools(ctx);
    const seed = pluginToolWithExecute("seed", "Fixture", async () => jsonResult(true));
    applyCodeModeCatalog({ ...ctx, tools: [...tools, seed] });
    try {
      const saved = resultDetails(
        await tools[0]!.execute("seed", { code: "return await results.save({value:42});" }),
      );
      expect(saved.status).toBe("completed");
      const id = (saved.value as { id: string }).id;
      const parked =
        transition === "replacement" || transition === "restriction"
          ? resultDetails(
              await tools[0]!.execute("parked", {
                code: `await yield_control(); return await results.load(${JSON.stringify(id)});`,
              }),
            )
          : undefined;
      if (transition === "restriction") {
        restrictToolSearchCatalog({ ...ctx, allowedToolNames: new Set() });
      }
      if (transition === "replacement") {
        registerHeadlessToolSearchCatalog({ catalogRef: h.catalogRef, tools: [seed] });
      }
      if (transition === "clear") {
        clearToolSearchCatalog(ctx);
        registerHeadlessToolSearchCatalog({ catalogRef: h.catalogRef, tools: [seed] });
      }
      if (transition === "abort") {
        abort.abort();
        ctx.abortSignal = new AbortController().signal;
      }
      if (transition === "run") {
        ctx.runId = "other-run";
      }
      if (transition === "session") {
        ctx.sessionId = "other-session";
      }
      if (parked) {
        expect(parked.status).toBe("waiting");
        expect(
          resultDetails(await tools[1]!.execute("stale", { runId: parked.runId })),
        ).toMatchObject({
          status: "failed",
          error: expect.stringContaining("run catalog changed or closed"),
        });
      }
      const fresh = createCodeModeTools(ctx);
      expect(
        resultDetails(
          await fresh[0]!.execute("expired", {
            code: `return await results.load(${JSON.stringify(id)});`,
          }),
        ),
      ).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/unavailable or expired|different run or session/),
      });
    } finally {
      clearToolSearchCatalog(ctx);
    }
  },
);

it("preserves results through client append and wait, and exposes canonical TypeScript declarations", async () => {
  const h = createCodeModeHarness();
  const collision = pluginToolWithExecute("results", "A tool named results", async () =>
    jsonResult("tool"),
  );
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, collision] });
  try {
    const saved = resultDetails(
      await h.tools[0]!.execute("save", {
        language: "typescript",
        typecheck: true,
        code: 'const ref = await results.save({name:"sample"}); return {id:ref.id, count:ref.count};',
      }),
    );
    expect(saved).toMatchObject({
      status: "completed",
      value: { id: expect.any(String), count: 1 },
    });
    const id = (saved.value as { id: string }).id;
    addClientToolsToToolCatalog({
      ...h.ctx,
      enabled: true,
      tools: [
        {
          name: "client_fixture",
          label: "Client fixture",
          description: "Fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => jsonResult(true),
        },
      ],
    });
    const parked = resultDetails(
      await h.tools[0]!.execute("wait", {
        code: `const value = await results.load(${JSON.stringify(id)}); await yield_control(); return {value, tool: await (await catalog.search("results"))[0]({}), declarations:(await API.read("results.d.ts")).content};`,
      }),
    );
    expect(parked.status).toBe("waiting");
    expect(
      resultDetails(await h.tools[1]!.execute("resume", { runId: parked.runId })),
    ).toMatchObject({
      status: "completed",
      value: {
        value: { name: "sample" },
        tool: "tool",
        declarations: expect.stringContaining("load(id: string): Promise<unknown>"),
      },
    });
  } finally {
    clearToolSearchCatalog(h.ctx);
  }
});

it("preserves network provenance when later cells load, transform, and resave data", async () => {
  const h = createCodeModeHarness();
  const network = pluginToolWithExecute("network_rows", "Read remote data", async () =>
    jsonResult([{ name: "untrusted <|endoftext|>" }]),
  );
  network.resultContentSource = "network";
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, network] });
  try {
    const saved = resultDetails(
      await h.tools[0]!.execute("network-save", {
        code: "return await results.save(await network_rows({}));",
      }),
    );
    expect(saved.status).toBe("completed");
    let id = (saved.value as { id: string }).id;
    const resaved = await h.tools[0]!.execute("network-resave", {
      code: `return await results.save(await results.load(${JSON.stringify(id)}));`,
    });
    expect(resaved.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
    id = (resultDetails(resaved).value as { id: string }).id;
    const loaded = await h.tools[0]!.execute("network-load", {
      code: `return (await results.load(${JSON.stringify(id)}))[0].name;`,
    });
    expect(loaded.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
    expect(loaded.content[0]).not.toMatchObject({ text: expect.stringContaining("<|endoftext|>") });
    expect(network.execute).toHaveBeenCalledOnce();
  } finally {
    clearToolSearchCatalog(h.ctx);
  }
});
