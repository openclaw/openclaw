/** Synthetic fixture only; run with --expose-gc --import ./scripts/tsx.mjs.
 * Five alternating pairs after warmup. --control uses baseline in both arms.
 * --allocation samples host allocations separately from uninstrumented timing.
 * The baseline generic sweep is absent work, not a competing implementation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    baseline: { type: "string" },
    output: { type: "string" },
    control: { type: "boolean" },
    allocation: { type: "boolean" },
    operations: { type: "string", default: "100" },
  },
});
assert(values.root && values.baseline && values.output && global.gc);
assert(!existsSync(values.output), "Refusing to overwrite evidence");
const root = path.resolve(values.root);
const fixture = JSON.parse(readFileSync(path.join(root, "fixture.json"), "utf8"));
assert.equal(fixture.format, "openclaw-session-read-transactions-v1");
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
const repo = process.cwd();
const sourceUrl = (file) => pathToFileURL(path.join(repo, file)).href;
const { createGatewayBenchEnv } = await import(sourceUrl("scripts/lib/gateway-bench-runtime.ts"));
Object.assign(
  process.env,
  createGatewayBenchEnv(root, path.join(root, "openclaw.json"), {
    caseEnv: { OPENCLAW_STATE_DIR: root },
  }),
);
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
const { setRuntimeConfigSnapshot } = await import(sourceUrl("src/config/runtime-snapshot.ts"));
setRuntimeConfigSnapshot(cfg);
const canonical = sourceUrl("src/agents/tools/sessions-yield-tool.ts");
const sources = [readFileSync(values.baseline, "utf8"), readFileSync(new URL(canonical), "utf8")];
if (values.control) {
  sources[1] = sources[0];
}
const urls = sources.map((_, arm) => `${canonical}?yield-measure=${arm}`);
registerHooks({
  load(url, context, next) {
    const arm = urls.indexOf(url);
    return arm < 0
      ? next(url, context)
      : {
          format: "module",
          shortCircuit: true,
          source: stripTypeScriptTypes(sources[arm], { sourceUrl: url }),
        };
  },
});
const { createRequesterYieldCallback } = await import(
  sourceUrl("src/agents/openclaw-tools.requester-yield.ts")
);
const { createSessionRowProjection } = await import(
  sourceUrl("src/gateway/session-row-projection.ts")
);
const { bindSessionRowProjection } = await import(
  sourceUrl("src/gateway/session-row-projection-access.ts")
);
const { sweepUnreachableSessionYields } = await import(
  sourceUrl("src/gateway/session-yield-sweep.ts")
);
const { closeOpenClawAgentDatabasesAsync } = await import(
  sourceUrl("src/state/openclaw-agent-db.ts")
);
const { closeOpenClawStateDatabaseAsync } = await import(
  sourceUrl("src/state/openclaw-state-db-cache.ts")
);
const { createSessionsYieldTool: before } = await import(urls[0]);
const { createSessionsYieldTool: after } = await import(urls[1]);
const sessionKey = "agent:main:lane2035-session-00000";
const claimYield = createRequesterYieldCallback({
  requesterSessionKey: sessionKey,
  requesterAgentId: "main",
  requesterTurnRunId: "human-followup",
});
const tools = [before, after].map((create) =>
  create({
    sessionId: "lane2035-session-00000",
    claimYield,
    onYield: () => assert.fail("A no-source yield must leave the model turn open"),
  }),
);
const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
const context = bindSessionRowProjection({}, () => projection);
const resolveGatewayContext = () => context;
const signal = new AbortController().signal;
let selectedRows = 0;
const selectEntries = projection.selectEntries;
projection.selectEntries = (...args) => {
  const rows = selectEntries(...args);
  selectedRows += rows.length;
  return rows;
};
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
}
const results = [];
const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
try {
  await projection.prepareSelection({ metadataOnly: true, includeCatalog: false });
  assert.equal(projection.selectEntries({ sortBy: null }, true).length, fixture.sessionCount);
  for (const mode of ["admission", "idle-sweep"]) {
    const run = async (arm) => {
      if (mode === "admission") {
        const result = await tools[arm].execute("synthetic-yield", {});
        assert.equal(result.details.status, "nothing_pending");
      } else if (arm === 1 && !values.control) {
        await sweepUnreachableSessionYields(resolveGatewayContext, signal);
      }
    };
    for (let warm = 0; warm < 20; warm++) {
      await run(0);
      await run(1);
    }
    for (let pair = 0; pair < 5; pair++) {
      for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
        global.gc();
        selectedRows = 0;
        if (values.allocation) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 16384,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const hostLoad = loadavg();
        const cpuBefore = process.cpuUsage();
        const start = performance.now();
        for (let operation = 0; operation < operations; operation++) {
          await run(arm);
        }
        const elapsedMs = performance.now() - start;
        const cpu = process.cpuUsage(cpuBefore);
        const sampledBytes = values.allocation
          ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
          : undefined;
        results.push({
          mode,
          pair,
          arm,
          operations,
          elapsedMs,
          cpuMs: (cpu.user + cpu.system) / 1000,
          sampledBytes,
          selectedRows,
          hostLoad,
        });
      }
    }
  }
  writeFileSync(
    values.output,
    JSON.stringify(
      {
        fixture,
        node: process.version,
        control: Boolean(values.control),
        allocation: Boolean(values.allocation),
        sources: sources.map((source) => createHash("sha256").update(source).digest("hex")),
        results,
      },
      null,
      2,
    ),
  );
} finally {
  inspector.disconnect();
  projection.dispose();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
