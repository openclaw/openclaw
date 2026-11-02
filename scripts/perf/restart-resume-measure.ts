/**
 * Measure restart preparation through its exported owner, including real worker reads.
 * Seed with scripts/perf/session-read-transactions-fixture.mjs, then run:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/restart-resume-measure.ts \
 *   --root <synthetic-fixture> --baseline <saved-session-restart-resume.ts> \
 *   --output <new-report.json> [--control] [--allocation] [--seed]
 * Five counterbalanced pairs; use --control for A/A and separate allocation runs.
 * --seed adds eight interrupted turns and four shutdown markers to the offline fixture.
 * The context provides only preparation's configuration; returned admission work is
 * never invoked. This measures discovery, not model admission or Gateway readiness.
 * Process CPU includes workers; sampled allocation covers only the host isolate.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    baseline: { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "10" },
    control: { type: "boolean" },
    allocation: { type: "boolean" },
    seed: { type: "boolean" },
  },
});
assert(values.root && values.baseline && values.output && global.gc);
assert(!existsSync(values.output), "Refusing to overwrite evidence");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 10,
});
const root = path.resolve(values.root);
const fixture = JSON.parse(readFileSync(path.join(root, "fixture.json"), "utf8"));
assert.equal(fixture.format, "openclaw-session-read-transactions-v1");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
const cfg: OpenClawConfig = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
const agent = await import("../../src/state/openclaw-agent-db.js");
const state = await import("../../src/state/openclaw-state-db.js");
agent.openOpenClawAgentDatabase({ agentId: "main" });
if (values.seed) {
  const { writeSessionEntry } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
  agent.runOpenClawAgentWriteTransaction(
    (owned) => {
      const rows = owned.db
        .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key LIMIT 12")
        .all();
      assert.equal(rows.length, 12);
      for (const [index, row] of rows.entries()) {
        const entry = JSON.parse(String(row.entry_json));
        writeSessionEntry(owned, String(row.session_key), {
          ...entry,
          ...(index < 8
            ? {
                lifecycleRunId: `synthetic-interrupted-${index}`,
                activeWriterRunId: `synthetic-interrupted-${index}`,
                startedAt: entry.updatedAt,
              }
            : { resumeAfterRestart: { queuedInputIds: [] } }),
        });
      }
    },
    { agentId: "main" },
  );
}
const canonical = new URL("../../src/gateway/session-restart-resume.ts", import.meta.url).href;
const sources = [readFileSync(values.baseline, "utf8"), readFileSync(new URL(canonical), "utf8")];
if (values.control) {
  sources[1] = sources[0]!;
}
const urls = sources.map((_, arm) => `${canonical}?restart-measure=${arm}`);
const loaded = new Set<string>();
registerHooks({
  load(url, context, nextLoad) {
    const arm = urls.indexOf(url);
    if (arm < 0) {
      return nextLoad(url, context);
    }
    loaded.add(url);
    return { format: "module", source: stripTypeScriptTypes(sources[arm]!), shortCircuit: true };
  },
});
type Owner = {
  prepareAgentRestartRecovery(input: {
    context: { getRuntimeConfig: () => OpenClawConfig };
    signal: AbortSignal;
    log: { warn: (message: string) => void };
    agentId: string;
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
  }): Promise<undefined | (() => Promise<void>)>;
};
const owners: Owner[] = [];
for (const url of urls) {
  owners.push(await import(url));
}
assert.equal(loaded.size, 2);
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
const signal = new AbortController().signal;
const context = { getRuntimeConfig: () => cfg };
const input = {
  context,
  signal,
  agentId: "main",
  env: process.env,
  assertCurrent() {},
  log: {
    warn(message: string) {
      throw new Error(message);
    },
  },
};
const inspector = new Session();
const samples = [];
let completedHistoryTasks = 0;
const taskDiagnostics = channel("openclaw.worker.task");
const onTask = (value: unknown) => {
  if (
    value &&
    typeof value === "object" &&
    "worker" in value &&
    typeof value.worker === "string" &&
    value.worker.startsWith("session-transcript.worker")
  ) {
    completedHistoryTasks++;
  }
};
taskDiagnostics.subscribe(onTask);
try {
  // Startup preparation and worker initialization are distinct from warmed discovery.
  const coldStarted = performance.now();
  assert.equal(typeof (await owners[0]!.prepareAgentRestartRecovery(input)), "function");
  const coldMs = performance.now() - coldStarted;
  assert.equal(typeof (await owners[1]!.prepareAgentRestartRecovery(input)), "function");
  if (values.allocation) {
    inspector.connect();
  }
  for (let pair = 0; pair < 5; pair++) {
    for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
      global.gc();
      if (values.allocation) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const hostLoad = loadavg();
      const tasksBefore = completedHistoryTasks;
      const processCpu = process.cpuUsage();
      const threadCpu = process.threadCpuUsage();
      const started = performance.now();
      for (let iteration = 0; iteration < iterations; iteration++) {
        assert.equal(typeof (await owners[arm]!.prepareAgentRestartRecovery(input)), "function");
      }
      const wallMs = (performance.now() - started) / iterations;
      const usedProcess = process.cpuUsage(processCpu);
      const usedThread = process.threadCpuUsage(threadCpu);
      const sampledBytes = values.allocation
        ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head) /
          iterations
        : undefined;
      samples.push({
        pair,
        arm,
        wallMs,
        processCpuMs: (usedProcess.user + usedProcess.system) / 1000 / iterations,
        threadCpuMs: (usedThread.user + usedThread.system) / 1000 / iterations,
        sampledBytes,
        historyWorkerTasksPerPreparation: (completedHistoryTasks - tasksBefore) / iterations,
        hostLoad,
      });
    }
  }
  writeFileSync(
    values.output,
    `${JSON.stringify(
      {
        scope: "Exported restart preparation; real SQLite worker reads; no resume admission",
        node: process.version,
        mode: values.allocation ? "allocation" : "timing",
        control: values.control ?? false,
        iterations,
        coldFirstArmMs: coldMs,
        fixture,
        sourceHashes: sources.map((source) => createHash("sha256").update(source).digest("hex")),
        samples,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ output: values.output, samples }));
} finally {
  taskDiagnostics.unsubscribe(onTask);
  inspector.disconnect();
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
