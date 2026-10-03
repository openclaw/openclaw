import { afterEach, describe, expect, it } from "vitest";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  expectOriginalCodeModeMarker,
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  fakeTool,
  mcpTool,
  resultDetails,
  resetCodeModeTestState,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import {
  addClientToolsToToolCatalog,
  registerHeadlessToolSearchCatalog,
  restrictToolSearchCatalog,
} from "./tool-search-catalog.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const cleanups: Array<() => void> = [];
afterEach(async () => {
  await resetCodeModeTestState();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function setup(
  targets: AnyAgentTool[] = [],
  options?: Parameters<typeof createCodeModeHarness>[0],
) {
  const h = createCodeModeHarness(options);
  const abort = new AbortController();
  const ctx = { ...h.ctx, abortSignal: abort.signal };
  const tools = createCodeModeTools(ctx);
  applyCodeModeCatalog({ ...ctx, tools: [...tools, ...targets] });
  cleanups.push(() => clearToolSearchCatalog(ctx));
  const execute = (code: string) => tools[0]!.execute("cell", { code });
  return {
    ctx,
    abort,
    tools,
    execute,
    run: async (code: string) => resultDetails(await execute(code)),
  };
}

it.each(["UTF-8 bytes", "entry count"])(
  "preserves saved data at the %s cap and reuses deleted capacity",
  async (limit) => {
    const bytes = limit === "UTF-8 bytes";
    const { run } = setup(
      [],
      bytes ? { codeMode: { maxSnapshotBytes: 1024, maxOutputBytes: 1024 } } : undefined,
    );
    let id = "";
    if (bytes) {
      const saved = await run('return await results.save("🦞".repeat(255));');
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
      id = JSON.stringify((saved.value as { id: string }).id);
    }
    const seed = bytes
      ? ""
      : "const refs = []; for (let i = 0; i < 64; i++) refs.push(await results.save(i));";
    const load = bytes ? id : "refs[0].id";
    const remove = bytes ? id : "refs[1].id";
    const replacement = bytes ? '"🦞".repeat(255)' : "{ok:true}";
    const result = await run(`${seed}
    let overflow; try { await results.save(${bytes ? 123 : 65}); } catch (error) { overflow = error.message; }
    const first = await results.load(${load});
    await results.delete(${remove});
    const replacement = await results.save(${replacement});
    return {overflow, ${bytes ? "length:first.length, bytes:replacement.bytes" : "first, replacement:await results.load(replacement.id)"}};`);
    expect(result).toMatchObject({
      status: "completed",
      value: {
        overflow: expect.stringContaining("results capacity exceeded"),
        ...(bytes ? { length: 510, bytes: 1022 } : { first: 0, replacement: { ok: true } }),
      },
    });
    if (bytes) {
      expect(await run(`return await results.load(${id});`)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("unavailable or expired"),
      });
    }
  },
);

it.each(["replacement", "restriction", "clear", "abort", "run", "session"] as const)(
  "rejects saved data after %s invalidation",
  async (transition) => {
    const seed = pluginToolWithExecute("seed", "Fixture", async () => jsonResult(true));
    const { ctx, abort, tools, run } = setup([seed]);
    const saved = await run("return await results.save({value:42});");
    expect(saved.status).toBe("completed");
    const id = JSON.stringify((saved.value as { id: string }).id);
    const parked =
      transition === "replacement" || transition === "restriction"
        ? await run(`await yield_control(); return await results.load(${id});`)
        : undefined;
    switch (transition) {
      case "restriction":
        restrictToolSearchCatalog({ ...ctx, allowedToolNames: new Set() });
        break;
      case "clear":
        clearToolSearchCatalog(ctx);
        registerHeadlessToolSearchCatalog({ catalogRef: ctx.catalogRef, tools: [seed] });
        break;
      case "replacement":
        registerHeadlessToolSearchCatalog({ catalogRef: ctx.catalogRef, tools: [seed] });
        break;
      case "abort":
        abort.abort();
        ctx.abortSignal = new AbortController().signal;
        break;
      case "run":
        ctx.runId = "other-run";
        break;
      case "session":
        ctx.sessionId = "other-session";
        break;
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
        await fresh[0]!.execute("expired", { code: `return await results.load(${id});` }),
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/unavailable or expired|different run or session/),
    });
  },
);

it("preserves results when client tools append while parked", async () => {
  const collision = pluginToolWithExecute("results", "A tool named results", async () =>
    jsonResult("tool"),
  );
  const { ctx, tools, run } = setup([collision]);
  const saved = await run(
    'const ref = await results.save({name:"sample"}); return {id:ref.id, count:ref.count};',
  );
  expect(saved).toMatchObject({ status: "completed", value: { id: expect.any(String), count: 1 } });
  const id = JSON.stringify((saved.value as { id: string }).id);
  const parked = await run(
    `await yield_control(); const value = await results.load(${id}); const copy = await results.save(value); await results.delete(copy.id); return {value, tool: await (await catalog.search("results"))[0]({}), declarations:(await API.read("results.d.ts")).content};`,
  );
  expect(parked.status).toBe("waiting");
  addClientToolsToToolCatalog({
    ...ctx,
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
  expect(resultDetails(await tools[1]!.execute("resume", { runId: parked.runId }))).toMatchObject({
    status: "completed",
    value: {
      value: { name: "sample" },
      tool: "tool",
      declarations: expect.stringContaining("load(id: string): Promise<unknown>"),
    },
  });
});

it("preserves network provenance when later cells load, transform, and resave data", async () => {
  const network = pluginToolWithExecute("network_rows", "Read remote data", async () =>
    jsonResult([{ name: "untrusted <|endoftext|>" }]),
  );
  network.resultContentSource = "network";
  const { run, execute } = setup([network]);
  const saved = await run("return await results.save(await network_rows({}));");
  expect(saved.status).toBe("completed");
  const resaved = await execute(
    `return await results.save(await results.load(${JSON.stringify((saved.value as { id: string }).id)}));`,
  );
  expect(resaved.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
  });
  const loaded = await execute(
    `return (await results.load(${JSON.stringify((resultDetails(resaved).value as { id: string }).id)}))[0].name;`,
  );
  expect(loaded.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
  });
  expect(loaded.content[0]).not.toMatchObject({ text: expect.stringContaining("<|endoftext|>") });
  expect(network.execute).toHaveBeenCalledOnce();
});

function rejectionHarness(maxOutputBytes = 65_536) {
  const h = createCodeModeHarness({ codeMode: { maxOutputBytes } });
  const failing = pluginToolWithExecute("failing_tool", "Fails", async () => {
    throw new Error("lost failure");
  });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, failing] });
  return {
    tools: h.tools,
    failing,
    run: (code: string) =>
      runUntilCompleted({ execTool: h.tools[0]!, waitTool: h.tools[1]!, code }),
  };
}

it.each(["return", "throw"])(
  "does not repeat yielded output when %s text is truncated",
  async (action) => {
    const { tools } = rejectionHarness(1024);
    const first = resultDetails(
      await tools[0]!.execute("yield", {
        code: `text("already delivered"); await yield_control(); ${action} ${action === "throw" ? 'new Error("x".repeat(10000))' : '"x".repeat(10000)'};`,
      }),
    );
    expect(first).toMatchObject({
      status: "waiting",
      output: [{ type: "text", text: "already delivered" }],
    });
    const final = resultDetails(await tools[1]!.execute("resume", { runId: first.runId }));
    expect(final).toMatchObject({
      status: action === "throw" ? "failed" : "completed",
      output: [],
    });
    if (action === "return") {
      expectOriginalCodeModeMarker(final.value, "x".repeat(10000));
    }
  },
);

it.each([
  { name: "detached tool", code: "void failing_tool({});" },
  { name: "timer callback", code: 'setTimeout(() => { throw new Error("lost failure"); }, 0);' },
])("reports an unhandled $name instead of success", async ({ code }) => {
  const result = await rejectionHarness().run(`const marker = true;\n${code} return "done";`);
  expect(result).toMatchObject({
    status: "failed",
    error: expect.stringContaining("lost failure"),
  });
  expect(String(result.error)).not.toContain("controller.js");
  expect(String(result.error)).toMatch(/openclaw-code-mode:user\.js:2:\d+/);
  expect(testing.activeRuns.size).toBe(0);
});

it.each([
  {
    name: "a late catch",
    diagnostics: false,
    code: 'const rejected = Promise.reject(new Error("handled later")); await yield_control(); await rejected.catch(() => {}); return "done";',
  },
  {
    name: "tool diagnostics",
    diagnostics: true,
    code: `
    const results = await Promise.allSettled([failing_tool({}), Promise.resolve("ok")]);
    const failure = results[0].reason;
    failure.code = "SYNTHETIC";
    await yield_control();
    text(failure); json({ results }); return { results };
  `,
  },
])("preserves handled rejection through wait: $name", async ({ code, diagnostics }) => {
  const { run, failing } = rejectionHarness();
  const result = await run(code);
  expect(testing.activeRuns.size).toBe(0);
  if (!diagnostics) {
    expect(result).toMatchObject({ status: "completed", value: "done" });
    return;
  }
  const failure = {
    name: "Error",
    message: "lost failure",
    code: "SYNTHETIC",
    effectStatus: "unknown",
    location: expect.stringMatching(/openclaw-code-mode:user\.js:2:/),
  };
  const value = {
    results: [
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: "ok" },
    ],
  };
  expect(result).toMatchObject({ status: "completed", value });
  expect(result.output).toEqual([
    { type: "text", text: expect.any(String) },
    { type: "json", value },
  ]);
  expect(JSON.parse((result.output as Array<{ text: string }>)[0]!.text)).toEqual(failure);
  expect(JSON.stringify(result.output)).not.toContain("controller.js");
  expect(failing.execute).toHaveBeenCalledOnce();
});

it("projects nested Errors before their custom toJSON can hide the failure", async () => {
  const result = await runCodeModeScriptHeadless({
    ctx: createHeadlessCodeModeHarness(),
    code: `let invoked = false;
      const error = new TypeError("visible diagnostic");
      error.toJSON = () => { invoked = true; throw new Error("hidden"); };
      json({ error }); text(error); return { error, invoked };`,
  });
  const error = { name: "TypeError", message: "visible diagnostic" };
  expect(result).toMatchObject({ status: "completed", value: { error, invoked: false } });
  expect(result.output).toEqual([
    { type: "json", value: { error } },
    { type: "text", text: JSON.stringify(error) },
  ]);
});

it("bounds headless failure diagnostics", async () => {
  const error = "Error: " + '\\"\n😀'.repeat(10_000);
  const result = await runCodeModeScriptHeadless({
    ctx: createHeadlessCodeModeHarness(),
    code: `text("before failure"); throw new Error(${JSON.stringify(error)});`,
    overrides: { maxOutputBytes: 1024 },
  });
  expect(result).toMatchObject({
    status: "failed",
    error: expect.stringContaining("[error truncated]"),
  });
  if (result.status !== "failed") {
    throw new Error("expected failure");
  }
  expect(
    Buffer.byteLength(JSON.stringify(result.error)) +
      Buffer.byteLength(JSON.stringify(result.output)),
  ).toBeLessThanOrEqual(1024);
});

describe("Code Mode tool execution scheduling", () => {
  it.each(["native", "mcp"] as const)(
    "honors sequential-only %s tools through independent calls",
    async (source) => {
      let active = 0;
      let maximumActive = 0;
      let calls = 0;
      const execute: AnyAgentTool["execute"] = async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          // A real host turn lets every incorrectly parallel invocation enter.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          return source === "mcp"
            ? projectMcpCallToolResult({ structuredContent: { ok: true } })
            : jsonResult({ ok: true });
        } finally {
          active -= 1;
        }
      };
      const tool: AnyAgentTool =
        source === "mcp"
          ? mcpTool({
              name: "probe__ordered_probe",
              serverName: "probe",
              toolName: "ordered_probe",
              execute,
            })
          : { ...fakeTool("ordered_probe", "Ordered probe"), execute };
      tool.executionMode = "sequential";
      const ctx = createHeadlessCodeModeHarness([tool]);
      const call = source === "mcp" ? "MCP.probe.orderedProbe({})" : "ordered_probe({})";
      const code = `const values = await Promise.all([${call}, ${call}]); return ${source === "mcp" ? "values.map(value => value.structuredContent)" : "values"};`;
      const result =
        source === "native"
          ? await runCodeModeScriptHeadless({ ctx, code })
          : resultDetails(await createCodeModeTools(ctx)[0]!.execute("ordered-call", { code }));

      expect(result).toMatchObject({ status: "completed", value: [{ ok: true }, { ok: true }] });
      expect(calls).toBe(2);
      expect(maximumActive).toBe(1);
      expect(active).toBe(0);
    },
  );
});
