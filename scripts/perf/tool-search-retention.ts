/**
 * Synthetic Tool Search and Code Mode retention through the agent runtime.
 * node --max-old-space-size=16384 --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/tool-search-retention.ts candidate [--snapshots] [tool-search-base.ts]
 * Save the original tool-search.ts with git show to replay it against the same fixture.
 * Use fresh isolated state, two identical baseline controls, and five serial A/B pairs.
 * Compare output hashes, post-GC old generation, owner timings, CPU, and allocation.
 * For Node 24 main-isolate allocation, sum V8 --trace-gc-nvp allocated bytes after cohort 0.
 * With --snapshots, compare cohort 0 to 8 and then release the fixed structured surfaces.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import { Type } from "typebox";
import type { ToolSearchToolContext } from "../../src/agents/tool-search-types.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";

assert(global.gc);
const probeArm = process.argv[2] ?? "probe";
const snapshots = process.argv.includes("--snapshots");
assert(process.env.OPENCLAW_STATE_DIR, "Set OPENCLAW_STATE_DIR to isolated synthetic state");
const baseFile = process.argv.find((arg) => arg.endsWith("-base.ts"));
if (baseFile) {
  const source = readFileSync(baseFile, "utf8");
  const owner = new URL("../../src/agents/tool-search.ts", import.meta.url).href;
  registerHooks({
    load(url, context, nextLoad) {
      return url === owner
        ? { format: "module-typescript", source, shortCircuit: true }
        : nextLoad(url, context);
    },
  });
}
const { wrapToolWithBeforeToolCallHook } =
  await import("../../src/agents/agent-tools.before-tool-call.wrapper.js");
const { applyCodeModeCatalog, createCodeModeTools } = await import("../../src/agents/code-mode.js");
const { ToolSearchRuntime } = await import("../../src/agents/tool-search-runtime.js");
const {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} = await import("../../src/agents/tool-search.js");
const { jsonResult } = await import("../../src/agents/tools/common.js");
const { fetchGitHubJson } = await import("../../extensions/github/src/github-api.js");
const config = { tools: { codeMode: { enabled: true, timeoutMs: 30_000 }, toolSearch: true } };
const modelContextWindowTokens = 128_000;
const parameters = Type.Object({ value: Type.Number() }, { additionalProperties: false });
const network: AnyAgentTool = {
  name: "get_record",
  label: "Get record",
  description: "Read a synthetic external record",
  parameters,
  resultContentSource: "network" as const,
  execute: async (_id, args) => jsonResult(args),
};
const structured = Array.from({ length: 16 }, (_, n) => {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [network] });
  const controls = createToolSearchTools({
    catalogRef,
    config,
    modelContextWindowTokens,
    runId: `long-session-${n}`,
  });
  const dispatch = controls.find((tool) => tool.name === "dispatch_action");
  assert(dispatch);
  return { catalogRef, dispatch };
});
const wrappedRefs: WeakRef<object>[] = [];
const record = {
  id: 1,
  title: "Synthetic record",
  payload: Array.from({ length: 140 }, (_, n) => ({
    id: n,
    text: `Record ${n} ` + "synthetic field ".repeat(16),
  })),
};
const body = JSON.stringify(record);
const stub: typeof fetch = async () => new Response(body, { headers: { etag: '"fixture-v1"' } });
const digest = createHash("sha256");
const runSearch = resolveToolSearchConfig(config);
const ownerMs = { structured: 0, nested: 0, catalog: 0, github: 0, realExec: 0 };
let nested = 0,
  realExec = 0,
  structuredCalls = 0,
  catalogs = 0,
  githubReads = 0;
const sessionsPerCohort = 128;
async function runCohort(cohort: number) {
  for (let session = 0; session < sessionsPerCohort; session++) {
    const sequence = cohort * sessionsPerCohort + session;
    const catalogRef = createToolSearchCatalogRef();
    const ctx = {
      catalogRef,
      config,
      modelContextWindowTokens,
      runId: `lane2789-run-${sequence}`,
      sessionId: `lane2789-session-${sequence}`,
      sessionKey: `agent:fixture:session-${sequence}`,
      executeTool: async ({
        tool,
        toolCallId,
        input,
        signal,
        onUpdate,
        acceptResultBeforeProjection,
      }) => {
        if (snapshots && wrappedRefs.length < 32) {
          wrappedRefs.push(new WeakRef(tool));
        }
        // This fixture registers only native agent tools.
        return await acceptResultBeforeProjection(
          await (tool as AnyAgentTool).execute(toolCallId, input, signal, onUpdate),
        );
      },
    } satisfies ToolSearchToolContext;
    let started = performance.now();
    const target = wrapToolWithBeforeToolCallHook(
      { ...network, name: "fixture_read" },
      { runId: ctx.runId, config },
    );
    const suffix = sequence % 96;
    const tools = [
      target,
      ...Array.from({ length: 31 }, (_, n) => ({
        ...network,
        name: `fixture_${n}`,
        description: `Read reports for synthetic workspace profile ${suffix} with index ${n}`,
      })),
    ];
    const controls = createCodeModeTools(ctx);
    const { tools: compacted } = applyCodeModeCatalog({
      ...ctx,
      tools: [...controls, ...tools],
      toolHookContext: { runId: ctx.runId, config },
    });
    const exec = compacted.find((tool) => tool.name === "exec");
    assert(exec && catalogRef.current?.entries.length === tools.length);
    ownerMs.catalog += performance.now() - started;
    catalogs++;
    started = performance.now();
    const runtime = new ToolSearchRuntime(ctx, runSearch, {
      prepareInput: true,
      validateInput: true,
    });
    assert((await runtime.search("synthetic workspace reports", { limit: 8 })).length === 8);
    const entry = catalogRef.current.entries.find((tool) => tool.name === "fixture_read");
    assert(entry);
    for (let n = 0; n < 9; n++) {
      const result = await runtime.callExactValue(
        entry.id,
        { value: n },
        { parentToolCallId: `nested-${sequence}` },
      );
      assert.deepEqual(result, { value: n });
      digest.update(JSON.stringify(result));
      nested++;
    }
    ownerMs.nested += performance.now() - started;
    if (sequence % 16 === 0) {
      started = performance.now();
      const call = await exec.execute(`real-${sequence}`, {
        code: "return await fixture_read({value: 7});",
      });
      assert(
        call.details && typeof call.details === "object" && "value" in call.details,
        JSON.stringify(call.details),
      );
      assert.deepEqual(call.details.value, { value: 7 });
      digest.update(JSON.stringify(call.details.value));
      realExec++;
      ownerMs.realExec += performance.now() - started;
    }
    clearToolSearchCatalog(ctx);
    started = performance.now();
    for (let n = 0; n < 4; n++) {
      const id = `lane2789-structured-${sequence}-${n}`;
      const surface = structured[(sequence * 4 + n) % structured.length]!;
      const call = await surface.dispatch.execute(id, { id: "get_record", args: { value: n } });
      assert(
        call.content[0]?.type === "text" &&
          call.content[0].text.includes("EXTERNAL_UNTRUSTED_CONTENT"),
      );
      // The external-content envelope carries a random marker. Hash only stable payloads.
      digest.update(JSON.stringify(call.details));
      structuredCalls++;
    }
    ownerMs.structured += performance.now() - started;
    started = performance.now();
    for (let n = 0; n < 2; n++) {
      const page = await fetchGitHubJson(
        `https://api.github.com/repos/synthetic/fixture/issues/${sequence * 2 + n + 1}`,
        stub,
      );
      assert.deepEqual(page, record);
      digest.update(String(record.id));
      githubReads++;
    }
    ownerMs.github += performance.now() - started;
  }
}
async function observe(cohort: number) {
  for (let i = 0; i < 4; i++) {
    await yieldTurn();
    global.gc?.();
  }
  const heap = process.memoryUsage().heapUsed;
  const old = getHeapSpaceStatistics().reduce(
    (total, space) =>
      space.space_name === "old_space" || space.space_name === "large_object_space"
        ? total + space.space_used_size
        : total,
    0,
  );
  const wrappers = wrappedRefs.filter((ref) => ref.deref()).length;
  wrappedRefs.length = 0;
  if (snapshots && [0, 4, 8, 9].includes(cohort)) {
    writeHeapSnapshot(`${probeArm}-${cohort}.heapsnapshot`);
  }
  console.log(
    JSON.stringify({
      cohort,
      heap,
      old,
      wrappers,
      structuredCalls,
      nested,
      realExec,
      catalogs,
      githubReads,
    }),
  );
}
console.log(
  JSON.stringify({
    node: process.version,
    arm: probeArm,
    bodyBytes: Buffer.byteLength(body),
    load: loadavg(),
  }),
);
await runCohort(0);
await observe(0);
const cpu = process.cpuUsage();
for (const owner of Object.keys(ownerMs) as (keyof typeof ownerMs)[]) {
  ownerMs[owner] = 0;
}
const started = performance.now();
for (let cohort = 1; cohort <= 8; cohort++) {
  await runCohort(cohort);
  await observe(cohort);
}
console.log(
  JSON.stringify({
    measure: true,
    ms: performance.now() - started,
    cpu: process.cpuUsage(cpu),
    ownerMs,
    digest: digest.digest("hex"),
  }),
);
structured.length = 0;
await observe(9);
