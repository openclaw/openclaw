/**
 * Prepared owner state-read workload, not a sessions.list or whole-Gateway benchmark.
 * mkdir -p .local
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-prepared-state-measure.ts
 *   --state-dir .local/prepared-state-run --iterations 3000 [--allocation] [--source-ref <commit>]
 * Each synchronous read frame serves 70 recipients, each destructuring read.state once
 * for captured config/context and live policy, matching prepareSessionRowRecipient.
 * The real projection-context owner indexes 10,000 synthetic completed subagent sessions;
 * config carries 40 plugin declarations, without loading plugins or opening a Gateway.
 * Metadata is resident input only: no list selection or row projection is measured.
 * --source-ref replaces only session-row-prepared-read.ts; all dependencies stay identical.
 * Run alternating base/candidate timing arms and separate collected-allocation arms.
 * Fixture construction, imports, warmup, and disposal are outside the measured interval.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SessionRowReadView } from "../../src/gateway/session-row-prepared-read.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "source-ref": { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 3000,
});
const ownerPath = "src/gateway/session-row-prepared-read.ts";
const ownerUrl = new URL(`../../${ownerPath}`, import.meta.url);
const gitOptions = {
  encoding: "utf8" as const,
  env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
};
const sourceRef = values["source-ref"]
  ? execFileSync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${values["source-ref"]}^{commit}`],
      gitOptions,
    ).trim()
  : undefined;
const source = sourceRef
  ? execFileSync("git", ["show", `${sourceRef}:${ownerPath}`], gitOptions)
  : readFileSync(ownerUrl, "utf8");
let replaced = false;
const compiled = transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    replaced = true;
    return { format: "module", source: compiled, shortCircuit: true };
  },
});
const stateDir = path.resolve(values["state-dir"]);
mkdirSync(stateDir, { mode: 0o700 });
const configPath = path.join(stateDir, "openclaw.json");
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = createGatewayBenchEnv(stateDir, configPath, { startupTrace: false });
const { readPreparedSessionRows } = await import("../../src/gateway/session-row-prepared-read.js");
const { createSessionRowProjectionContext } =
  await import("../../src/gateway/session-row-projection-context.js");
assert(replaced, "Requested owner revision was not loaded");

const sessions = 10_000;
const consumers = 70;
const runs = new Map<string, SubagentRunReadRecord>();
for (let index = 0; index < sessions; index++) {
  const runId = `synthetic-run-${index}`;
  runs.set(runId, {
    runId,
    childSessionKey: `agent:main:subagent:synthetic-${index}`,
    requesterSessionKey: `agent:main:dashboard:synthetic-${index % consumers}`,
    createdAt: 1,
    execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
  });
}
const metadata = createSessionRowProjectionContext({
  snapshotIdentity: () => runs,
  runs: (ids) => (ids ? new Map([...runs].filter(([id]) => ids.has(id))) : runs),
  prepare: async () => {},
});
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} } },
  session: { mainKey: "main" },
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`synthetic-${index}`, { enabled: true }]),
    ),
  },
};
const otherPolicy: OpenClawConfig = { ...cfg, session: { mainKey: "other" } };
let policy = cfg;
const state = { cfg, policyConfig: cfg, rowContext: metadata.current };
const unused = (): never => {
  throw new Error("State-read workload unexpectedly requested row materialization");
};
const owner: Parameters<typeof readPreparedSessionRows>[0] = {
  state,
  getPolicyConfig: () => policy,
  isCurrent: () => true,
  readChildVisibility: unused,
  readChildActivity: unused,
  readSource: unused,
  describe: unused,
  readMembership: unused,
  present: unused,
  selectEntries: unused,
  physicalPaths: unused,
};
const consume = (read: SessionRowReadView) => {
  let checksum = 0;
  for (let client = 0; client < consumers; client++) {
    const { cfg: capturedConfig, rowContext, policyConfig } = read.state;
    checksum += capturedConfig.session?.mainKey?.length ?? 0;
    checksum += rowContext.subagentRuns.runsByChildSessionKey.size;
    checksum += policyConfig.session?.mainKey?.length ?? 0;
  }
  return checksum;
};
const active = () => true;
const queries = () => [];
function run(count: number): number {
  let checksum = 0;
  for (let index = 0; index < count; index++) {
    checksum += readPreparedSessionRows(owner, active, queries, consume);
  }
  return checksum;
}
const inspector = new Session();
try {
  assert.equal(state.rowContext.subagentRuns.runsByChildSessionKey.size, sessions);
  readPreparedSessionRows(owner, active, queries, (read) => {
    const captured = read.state;
    assert.equal(captured.policyConfig, cfg);
    policy = otherPolicy;
    assert.equal(read.state.policyConfig, otherPolicy);
    assert.equal(captured.policyConfig, cfg);
    assert.equal(read.state.cfg, cfg);
    policy = cfg;
  });
  const expectedPerFrame = consumers * (sessions + 4 + 4);
  assert.equal(run(1), expectedPerFrame);
  run(1000);
  globalThis.gc?.();
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 1024);
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const checksum = run(iterations);
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const allocatedBytes = values.allocation
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  assert.equal(checksum, expectedPerFrame * iterations);
  console.log(
    JSON.stringify({
      workload: "prepared-owner-state-read",
      mode: values.allocation ? "allocation" : "timing",
      sourceRef: sourceRef ?? "working-tree",
      sourceSha256: hash("sha256", source),
      node: process.version,
      sessions,
      consumers,
      iterations,
      checksum,
      digest: hash("sha256", JSON.stringify({ checksum, iterations, sessions, consumers })),
      cpuUsPerFrame: (used.user + used.system) / iterations,
      allocationBytesPerFrame:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      elapsedMs,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  if (values.allocation) {
    inspector.disconnect();
  }
  metadata.dispose();
}
