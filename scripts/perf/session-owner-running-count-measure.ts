/**
 * Owner-only 2071 fixture: 10k sessions, 2k runs, 20 depth-100 chains, 70 profiles.
 * Run from the candidate checkout (frozen source trees share its prepared dependencies):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-owner-running-count-measure.ts \
 *   --repo <base> --compare-repo <candidate> --mode timing --shape all
 * Repeat with --mode allocation and --shape candidates. For A/A use the base twice.
 * Five counterbalanced pairs in separate sequential processes, 100 warmups and
 * 500 warm passes per arm; cold passes exclude index construction.
 * Accept allocation savings beyond A/A spread without
 * a consistent CPU, wall, or cold regression. No Gateway/RPC or storage claim.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";
import type {
  SessionEntrySelection,
  SessionListFilterParams,
} from "../../src/gateway/session-list-filters.js";
import type { SessionListTargetLookup } from "../../src/gateway/session-list-target.js";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: process.cwd() },
    "compare-repo": { type: "string" },
    mode: { type: "string", default: "timing" },
    shape: { type: "string", default: "all" },
    sample: { type: "boolean", default: false },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.shape === "all" || values.shape === "candidates");
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const mode = values.mode;
const shape = values.shape;
if (!values.sample) {
  // Sharing a call site across two imported source trees biases V8 optimization.
  // Each arm gets a fresh process; the coordinator never imports either owner.
  for (let pair = 0; pair < 5; pair++) {
    for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          "--import",
          new URL("../tsx.mjs", import.meta.url).href,
          fileURLToPath(import.meta.url),
          "--sample",
          "--repo",
          arm === 0 ? values.repo : (values["compare-repo"] ?? values.repo),
          "--mode",
          mode,
          "--shape",
          shape,
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      const sample: unknown = JSON.parse(child.stdout);
      assert(sample !== null && typeof sample === "object");
      console.log(JSON.stringify({ pair, arm, ...sample }));
    }
  }
} else {
  const now = Date.UTC(2026, 9, 31);
  const depth = 100;
  const iterations = 500;
  const runs = new Map<string, SubagentRunReadRecord>();
  const rows = new Map<string, NonNullable<ReturnType<SessionListTargetLookup>>>();
  const profiles = new Map<string, string>();
  function addRow(key: string) {
    rows.set(key, {
      storeKey: key,
      agentId: "synthetic",
      entry: { sessionId: key, updatedAt: now },
      selection: {
        agentId: "synthetic",
        isCronRun: false,
        isCron: false,
        isDock: false,
        isSystem: false,
        isSubagent: key.includes(":subagent:"),
        isPhantom: false,
      },
    });
  }
  for (let chain = 0; chain < 20; chain++) {
    let parent = `agent:synthetic:root-${chain}`;
    addRow(parent);
    for (let level = 0; level < depth; level++) {
      const runId = `synthetic-${chain}-${level}`;
      const key = `agent:synthetic:subagent:${runId}`;
      runs.set(runId, {
        runId,
        childSessionKey: key,
        requesterSessionKey: parent,
        generation: 1,
        createdAt: now - 1000,
        execution:
          level === depth - 1
            ? { status: "running", startedAt: now - 1000 }
            : { status: "terminal", endedAt: now - 500 },
        delivery: { status: "not_required" },
      });
      addRow(key);
      parent = key;
    }
  }
  while (rows.size < 10000) {
    addRow(`agent:synthetic:session-${rows.size}`);
  }
  let ordinal = 0;
  for (const key of rows.keys()) {
    profiles.set(key, `profile-${ordinal++ % 70}`);
  }
  const ownerSessionCounts = Array.from({ length: 70 }, (_, i) => ({
    profileId: `profile-${i}`,
    open: 0,
    running: 0,
  }));
  const selection: SessionEntrySelection = {
    entries: [],
    totalCount: rows.size,
    ownerCount: 70,
    ownerFacet: [],
    offset: 0,
    nextOffset: null,
    hasMore: false,
    ownerSessionProfiles: profiles,
    ownerSessionCounts,
  };
  const expected = ownerSessionCounts.map(({ profileId, open, running }) => ({
    profileId,
    open,
    running,
  }));
  // Each chain's root and 99 non-leaf children have one running descendant.
  for (let chain = 0; chain < 20; chain++) {
    for (let level = 0; level < depth; level++) {
      expected[(chain * (depth + 1) + level) % 70]!.running++;
    }
  }
  async function loadSource(repo: string) {
    const source = (file: string) => pathToFileURL(path.resolve(repo, file)).href;
    const query: typeof import("../../src/agents/subagents/registry/subagent-registry-queries.js") =
      await import(source("src/agents/subagents/registry/subagent-registry-queries.ts"));
    const filters: typeof import("../../src/gateway/session-list-filters.js") = await import(
      source("src/gateway/session-list-filters.ts")
    );
    return {
      build: query.buildSubagentRunReadIndexFromRuns,
      project: filters.projectSessionOwnerRunningCounts,
      priorProject: filters.projectSessionOwnerRunningCounts as unknown as (
        params: SessionListFilterParams,
        selection: SessionEntrySelection,
        candidates: () => Iterable<string>,
      ) => SessionEntrySelection,
    };
  }
  const source = await loadSource(values.repo);
  function createPass() {
    const index = source.build({ runs, now });
    let clock = now;
    const context = {
      subagentRuns: index,
      subagentRunsByChildSessionKey: index.runsByChildSessionKey,
      configuredDefaultModelByAgent: new Map(),
      thinkingFactsByModelRef: new Map(),
      displayModelIdentityByKey: new Map(),
      modelCostConfigByModelRef: new Map(),
      userProfileIdentityById: new Map(),
      findModelCatalogEntry: () => {
        throw new Error("Owner counts must not read model catalogs");
      },
      selectModelCatalogRuntimeEntry: () => {
        throw new Error("Owner counts must not select models");
      },
    };
    const params: SessionListFilterParams = {
      cfg: {},
      opts: {},
      entries: () => [],
      configuredAgentIds: new Set(["synthetic"]),
      now,
      getRowContext: () => context,
      getTarget: (key) => rows.get(key),
      involvementKeys: () => new Set(),
    };
    const candidateKeys = () => {
      if (shape === "all") {
        return rows.keys();
      }
      // Compare the former requester filter with the maintained owner fact.
      const prior = context.subagentRuns as typeof index & {
        requesterSessionKeys?: () => Iterable<string>;
      };
      return prior.requesterSessionKeys
        ? new Set(
            [...prior.requesterSessionKeys()].filter(
              (key) => prior.countActiveDescendantRuns(key) > 0,
            ),
          )
        : context.subagentRuns.activeRequesterSessionKeys();
    };
    return () => {
      context.subagentRuns = index.atTime(clock++);
      return (
        "requesterSessionKeys" in context.subagentRuns
          ? source.priorProject(params, selection, candidateKeys)
          : source.project(params, selection)
      ).ownerSessionCounts!;
    };
  }
  const inspector = new Session();
  if (mode === "allocation") {
    inspector.connect();
  }
  const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
  async function measure(pass: ReturnType<typeof createPass>, count: number) {
    gc!();
    const latencies = new Float64Array(count);
    const load = loadavg();
    if (mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const before = process.threadCpuUsage();
    const started = performance.now();
    let checksum = 0;
    let result;
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      result = pass();
      latencies[i] = performance.now() - start;
      checksum += result.reduce((sum, item) => sum + item.running, 0);
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.threadCpuUsage(before);
    const allocated =
      mode === "allocation"
        ? bytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
    assert.deepEqual(result, expected);
    assert.equal(checksum, 2000 * count);
    latencies.sort();
    return {
      passes: count,
      cpuMsPerPass: (cpu.user + cpu.system) / 1000 / count,
      wallMsPerPass: elapsedMs / count,
      p50Ms: latencies[Math.ceil(count * 0.5) - 1],
      p95Ms: latencies[Math.ceil(count * 0.95) - 1],
      allocatedBytesPerPass: allocated === undefined ? undefined : allocated / count,
      checksum,
      load,
      loadAfter: loadavg(),
    };
  }
  // Compile this source before measuring fresh owner state, separate from process startup.
  {
    const rehearsal = createPass();
    for (let warmup = 0; warmup < 100; warmup++) {
      rehearsal();
    }
  }
  const pass = createPass();
  const cold = await measure(pass, 1);
  for (let warmup = 0; warmup < 100; warmup++) {
    pass();
  }
  const warm = await measure(pass, iterations);
  console.log(
    JSON.stringify({ mode, shape, sessions: rows.size, runs: runs.size, depth, cold, warm }),
  );
  inspector.disconnect();
}
