/**
 * Usage: node --expose-gc scripts/perf/owned-snapshot-copies-measure.mjs BASE_ROOT CANDIDATE_ROOT [CALLS]
 * Owner microbenchmark, not whole-Gateway evidence. Loads exact recovery capture and MCP
 * mutation functions from each revision. MCP IO, persistence, validation, authority
 * issuance, and non-incognito routing use in-memory stubs. Recovery starts with a
 * frozen synthetic authority; this benchmark does not prove admission policy. Five
 * counterbalanced pairs measure CPU without heap sampling, then allocations separately.
 * Fixture: 40 model references; MCP config has 40 plugins, 100 agents, and 40 servers.
 * JSON lines include source hashes, host load, CPU/work, GC (including Node kind IDs),
 * end-of-arm RSS/heap, and sampled bytes/work
 * (including objects collected during sampling). TMPDIR controls generated module files.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { sampledOwnerBytes } from "../lib/sampled-owner-allocation.mjs";

const [baseRoot, candidateRoot, callsArg = "3000"] = process.argv.slice(2);
assert(baseRoot && candidateRoot, "expected BASE_ROOT CANDIDATE_ROOT");
assert(globalThis.gc, "run with --expose-gc");
const pairs = 5;
const calls = Number(callsArg);
assert(Number.isSafeInteger(calls) && calls > 0, "CALLS must be a positive integer");
const samplingInterval = 1024;
const generatedRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "owned-snapshot-copies-")));
process.once("exit", () => rmSync(generatedRoot, { recursive: true, force: true }));
const files = {
  recovery: "src/agents/operator-run-recovery-source.ts",
  immutable: "src/shared/immutable-data.ts",
  scopes: "src/shared/operator-scope-compat.ts",
  mcp: "src/config/mcp-config.ts",
};

function between(source, start, end) {
  assert.equal(source.split(start).length, 2, `expected one ${start}`);
  const tail = source.slice(source.indexOf(start));
  assert.equal(tail.split(end).length, 2, `expected one ${end}`);
  return tail.slice(0, tail.indexOf(end));
}

async function load(root, side) {
  const sources = Object.fromEntries(
    Object.entries(files).map(([key, file]) => [key, readFileSync(path.join(root, file), "utf8")]),
  );
  const hashes = Object.fromEntries(
    Object.entries(sources).map(([key, source]) => [
      key,
      createHash("sha256").update(source).digest("hex"),
    ]),
  );
  const recovery = between(
    sources.recovery,
    "export function createOperatorInputRecoverySource(",
    "/** Capture the admitted turn;",
  );
  const resolve = between(
    sources.mcp,
    "function resolveConfiguredMcpServers(",
    "function redactMcpServerArgsForDisplay(",
  );
  const mutate = between(
    sources.mcp,
    "async function mutateConfiguredMcpServer(",
    "async function updateConfiguredMcpServerTools(",
  );
  // Stubs model the already-admitted authority and external storage boundary, not owner logic.
  const code = stripTypeScriptTypes(`${sources.immutable}\n${sources.scopes}\n
const issued = new WeakSet();
function assertAdmittedRunOperatorAuthority(value) {
  if (!issued.has(value)) throw new Error("unissued benchmark authority");
}
const isIncognitoSessionKey = () => false;
export function issue(snapshot) {
  const authority = Object.freeze({
    recoverySnapshot: freezeJsonSnapshot(structuredClone(snapshot)),
    scopes: Object.freeze([...snapshot.scopes]), assertCurrent() {},
  });
  issued.add(authority);
  return authority;
}
${recovery}\n${resolve}\n${mutate}\n
let fixture;
export function configure(config) { fixture = config; }
async function readSourceConfigSnapshotForWrite() {
  return { snapshot: { valid: true, path: "/synthetic/config", sourceConfig: fixture, hash: "fixed" }, writeOptions: {} };
}
function validateConfigObjectWithPlugins() { return { ok: true }; }
async function replaceConfigFile({ sourceConfig, writeOptions }) {
  writeOptions.assertCurrent?.();
  await writeOptions.beforeCommit?.();
  return { nextConfig: sourceConfig };
}
export function mutate() { return mutateConfiguredMcpServer({ kind: "unset", name: "server-0" }); }
`);
  const file = path.join(generatedRoot, `${side}.mjs`);
  writeFileSync(file, code);
  const url = pathToFileURL(file).href;
  return { ...(await import(url)), url, hashes };
}

const owners = {
  base: await load(baseRoot, "base"),
  candidate: await load(candidateRoot, "candidate"),
};
const snapshot = {
  profileId: "synthetic-profile",
  scopes: ["operator.read", "operator.write"],
  assignedRole: "operator",
  githubLogin: null,
  grant: null,
  aliasBindingIds: ["synthetic-alias"],
  rolePolicy: { agents: ["main"], sessions: { others: "read" }, sandboxRequired: false },
  modelPolicy: {
    models: Array.from({ length: 40 }, (_, index) => ({
      provider: "fixture",
      model: `model-${index}`,
    })),
    allowed: { exact: ["fixture/model-0"], wildcards: ["fixture/*"] },
    denied: { exact: [], wildcards: [] },
  },
  authPolicy: {
    generation: "",
    grantGeneration: "synthetic",
    role: "operator",
    authMethod: "token",
    browserOrigin: { isLocalClient: true },
  },
  controlUiAdmin: false,
  localOperator: true,
  sourceIngress: "control-ui",
};
const config = {
  agents: {
    entries: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `agent-${index}`,
        { workspace: `/synthetic/agent-${index}`, model: { primary: "fixture/model-0" } },
      ]),
    ),
  },
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `plugin-${index}`,
        { enabled: true, config: { names: ["one", "two"], limits: { max: 40 } } },
      ]),
    ),
  },
  mcp: {
    servers: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `server-${index}`,
        { command: "synthetic", args: ["--fixture", `${index}`], env: { SYNTHETIC: "yes" } },
      ]),
    ),
  },
};
const sourceBefore = structuredClone(config);
const workloads = [
  {
    name: "operator-recovery",
    prepare(owner) {
      const authority = owner.issue(snapshot);
      const params = {
        authority,
        entry: { sessionId: "session", lifecycleRevision: "revision" },
        agentId: "main",
        sessionKey: "agent:main:main",
        sourceRunId: "run",
      };
      return () => owner.createOperatorInputRecoverySource(params);
    },
    isolate(result) {
      assert(Object.isFrozen(result.snapshot.authPolicy));
      assert.equal(Reflect.set(result.snapshot.authPolicy, "role", "changed"), false);
      assert.equal(snapshot.authPolicy.role, "operator");
    },
  },
  {
    name: "mcp-unset",
    prepare(owner) {
      owner.configure(config);
      return owner.mutate;
    },
    isolate(result) {
      assert.equal(result.removed, true);
      assert.equal(result.config.mcp.servers["server-0"], undefined);
      result.config.plugins.entries["plugin-0"].config.names.push("caller-mutation");
      assert.deepEqual(config, sourceBefore);
    },
  },
];

const results = [];
let checksum = 0;
let gcEntries = [];
const observer = new PerformanceObserver((list) => gcEntries.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
console.log(
  JSON.stringify({
    protocol: "owned-snapshot-copies-v1",
    node: process.version,
    pairs,
    calls,
    samplingInterval,
    hashes: { base: owners.base.hashes, candidate: owners.candidate.hashes },
    scope:
      "Exact owner functions; synthetic admission and in-memory MCP IO/validation/persistence stubs; no Gateway claim",
  }),
);
try {
  for (const workload of workloads) {
    const operations = Object.fromEntries(
      Object.entries(owners).map(([side, owner]) => [side, workload.prepare(owner)]),
    );
    const proof = await Promise.all([operations.base(), operations.candidate()]);
    assert.deepEqual(proof[0], proof[1]);
    proof.forEach((result) => workload.isolate(result));
    for (const operation of Object.values(operations)) {
      for (let index = 0; index < Math.min(200, calls); index++) {
        await operation();
      }
    }
    for (const mode of ["cpu", "allocation"]) {
      const inspector = mode === "allocation" ? new Session() : undefined;
      inspector?.connect();
      try {
        for (let pair = 0; pair < pairs; pair++) {
          for (const side of pair % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"]) {
            globalThis.gc();
            await setImmediate();
            await setImmediate();
            gcEntries = [];
            if (inspector) {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const hostLoad = loadavg();
            const cpu = process.cpuUsage();
            const thread = process.threadCpuUsage?.();
            const started = performance.now();
            for (let index = 0; index < calls; index++) {
              const result = await operations[side]();
              checksum += result.version ?? Number(result.removed);
            }
            const ended = performance.now();
            const cpuUsed = process.cpuUsage(cpu);
            const threadUsed = thread && process.threadCpuUsage(thread);
            const memory = process.memoryUsage();
            const allocation = inspector
              ? sampledOwnerBytes(
                  (await inspector.post("HeapProfiler.stopSampling")).profile,
                  owners[side].url,
                )
              : undefined;
            if (allocation && calls >= 100) {
              assert(allocation.bytes > 0, `no allocation attributed to ${workload.name}`);
            }
            await setImmediate();
            // GC performance entries arrive after the first immediate callback.
            await setImmediate();
            const pauses = gcEntries.filter(
              (entry) => entry.startTime >= started && entry.startTime < ended,
            );
            const gcByKind = new Map();
            for (const entry of pauses) {
              const kind = entry.detail.kind;
              const stats = gcByKind.get(kind) ?? { kind, count: 0, totalMs: 0, maxMs: 0 };
              stats.count++;
              stats.totalMs += entry.duration;
              stats.maxMs = Math.max(stats.maxMs, entry.duration);
              gcByKind.set(kind, stats);
            }
            const row = {
              workload: workload.name,
              mode,
              side,
              pair,
              calls,
              hostLoad,
              wallUsPerOp: ((ended - started) * 1000) / calls,
              processCpuUsPerOp: (cpuUsed.user + cpuUsed.system) / calls,
              threadCpuUsPerOp: threadUsed ? (threadUsed.user + threadUsed.system) / calls : null,
              gcMs: pauses.reduce((sum, entry) => sum + entry.duration, 0),
              gcMaxMs: Math.max(0, ...pauses.map((entry) => entry.duration)),
              gcCount: pauses.length,
              gcByKind: [...gcByKind.values()],
              rssBytes: memory.rss,
              heapUsedBytes: memory.heapUsed,
              ...(allocation
                ? {
                    sampledBytesPerOp: allocation.bytes / calls,
                    allocationSamples: allocation.samples,
                  }
                : {}),
            };
            results.push(row);
            console.log(JSON.stringify(row));
          }
        }
      } finally {
        inspector?.disconnect();
      }
    }
    assert.deepEqual(config, sourceBefore);
    for (const [mode, metric] of [
      ["cpu", "processCpuUsPerOp"],
      ["cpu", "threadCpuUsPerOp"],
      ["allocation", "sampledBytesPerOp"],
    ]) {
      const rows = results.filter((row) => row.workload === workload.name && row.mode === mode);
      if (rows.some((row) => row[metric] === null)) {
        continue;
      }
      const mean = (side) =>
        rows.filter((row) => row.side === side).reduce((sum, row) => sum + row[metric], 0) / pairs;
      const base = mean("base"),
        candidate = mean("candidate");
      console.log(
        JSON.stringify({
          summary: workload.name,
          mode,
          metric,
          base,
          candidate,
          absoluteDelta: candidate - base,
          deltaPercent: (candidate / base - 1) * 100,
        }),
      );
    }
  }
  assert(checksum > 0);
} finally {
  observer.disconnect();
}
