// Real recall owner and transcript worker, synthetic resident roster; no transport/model claim.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-recall-measure.ts \
//   --state-dir <new-directory> --sessions 600 --keys 130 [--owner-ref <baseline-sha>]
// Reuse the fixture serially with --reuse; alternate fresh baseline/candidate processes.
// Acceptance: identical ordered results, lower consume/main-thread CPU and V8 allocation
// beyond A/A spread, no sustained >20% worker CPU or p95 wall regression.
// Run >=5 serial, rotated A1/A2/B processes per fixture size. First calls are reported separately.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { transformSync } from "esbuild";
import type { SessionsSearchResult } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "600" },
    keys: { type: "string", default: "130" },
    iterations: { type: "string", default: "10" },
    samples: { type: "string", default: "5" },
    "owner-ref": { type: "string" },
    reuse: { type: "boolean" },
    allocation: { type: "boolean" },
  },
});
assert(values["state-dir"] && global.gc);
const root = path.resolve(values["state-dir"]);
const sessions = Number(values.sessions),
  keys = Number(values.keys);
const iterations = Number(values.iterations),
  samples = Number(values.samples);
assert([sessions, keys, iterations, samples].every((n) => Number.isSafeInteger(n) && n > 0));
assert(sessions >= 300 && keys >= 100 && keys <= sessions);
const sources = new Map(
  [
    "src/gateway/server-methods/sessions-search-recall.ts",
    "src/gateway/session-utils-list.ts",
    "src/gateway/session-row-selection.ts",
    "src/gateway/session-row-prepared-read.ts",
  ].map((filename) => {
    const url = new URL(`../../${filename}`, import.meta.url);
    return [
      url.href,
      values["owner-ref"]
        ? execFileSync("git", ["show", `${values["owner-ref"]}:${filename}`], { encoding: "utf8" })
        : readFileSync(url, "utf8"),
    ];
  }),
);
const compiled = new Map(
  [...sources].map(([url, source]) => [
    url,
    transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
  ]),
);
registerHooks({
  load(url, context, next) {
    const source = compiled.get(url);
    return source === undefined
      ? next(url, context)
      : { format: "module", source, shortCircuit: true };
  },
});
const anchor = Date.UTC(2026, 10, 1);
const configPath = path.join(root, "openclaw.json");
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: { main: { workspace: path.join(root, "workspace") } },
    defaults: { systemAgent: { agentId: "main" } },
  },
  tools: { sessions: { visibility: "all" } },
  plugins: { enabled: false },
  logging: { file: path.join(root, "gateway.log") },
  session: { maintenance: { maxEntries: sessions * 2 } },
};
if (!values.reuse) {
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(path.join(root, "workspace"));
  mkdirSync(path.join(root, "home"));
  writeFileSync(configPath, JSON.stringify(cfg));
}
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_SKIP_CHANNELS: "1",
};
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
const agentDb = await import("../../src/state/openclaw-agent-db.js");
const stateDb = await import("../../src/state/openclaw-state-db.js");
const { retainSessionListForegroundWork } =
  await import("../../src/gateway/session-projection-work.js");
const release = retainSessionListForegroundWork();
const fixture = { sessions, keys, transcriptBytes: 8 * 1024 * 1024 };
let projection:
  | import("../../src/gateway/session-row-projection.js").SessionRowProjection
  | undefined;
try {
  if (!values.reuse) {
    const { seedTeamShapeSessions } = await import("./team-shape-sessions.ts");
    await seedTeamShapeSessions({
      stateDir: root,
      sessions,
      retainedRuns: 0,
      seed: 2637,
      now: anchor,
      transcriptBytes: fixture.transcriptBytes,
      sessionKeys: Array.from({ length: keys }, (_, i) => `agent:main:recall-${i}`),
    });
    const { replaceSessionEntry, persistSessionTranscriptTurn } =
      await import("../../src/config/sessions/session-accessor.js");
    for (let i = 0; i < keys; i++) {
      const target = {
        agentId: "main",
        sessionKey: `agent:main:recall-${i}`,
        sessionId: `team-shape-session-${i}`,
      };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: anchor,
        createdActor: { type: "human", source: "profile", id: `team-shape-profile-${i % 24}` },
      });
      await persistSessionTranscriptTurn(target, {
        cwd: "/synthetic",
        updateMode: "none",
        messages: [
          {
            now: anchor + i,
            message: {
              role: "user",
              content:
                i % 4 === 1
                  ? "The notification worker rollout checklist is ready for review."
                  : "Planning notes for the notification worker rollout. 明天下午开会讨论排期。",
            },
          },
        ],
      });
    }
    writeFileSync(path.join(root, "fixture.json"), JSON.stringify(fixture));
  }
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "fixture.json"), "utf8")), fixture);
  const { createSessionRowProjection } =
    await import("../../src/gateway/session-row-projection.js");
  const { searchRecallSessionTranscripts } =
    await import("../../src/gateway/server-methods/sessions-search-recall.js");
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
  assert(projection.selectEntries({ sortBy: null }).length >= sessions);
  let consumeCpuMicros = 0;
  let consumeCount = 0;
  const withRows = projection.withPreparedExactRows.bind(projection);
  projection.withPreparedExactRows = (queries, consume, options) =>
    withRows(
      queries,
      (view) => {
        const before = process.threadCpuUsage();
        try {
          return consume(view);
        } finally {
          const used = process.threadCpuUsage(before);
          consumeCpuMicros += used.user + used.system;
          consumeCount++;
        }
      },
      options,
    );
  const { getTrackedWorkerCpuSources } = await import("../../src/infra/worker-cpu.js");
  const queries = [
    { query: "notification worker", visibility: "all", count: 25 },
    { query: "rollout checklist", visibility: "self", count: 1 },
    { query: "会", visibility: "self", count: 0 },
  ] as const;
  const read = async ({ query, visibility }: (typeof queries)[number]) => {
    let published: SessionsSearchResult | undefined;
    await searchRecallSessionTranscripts({
      projection: projection!,
      query,
      limit: 25,
      recall: { requesterAgentId: "main", requesterSessionKey: "agent:main:recall-1", visibility },
      onResult: (result) => {
        published = result;
      },
    });
    assert(published);
    return published;
  };
  const results = [];
  for (const query of queries) {
    const coldStart = performance.now();
    let expected = await read(query);
    const firstWallMs = performance.now() - coldStart;
    const firstIndexing = expected.indexing === true;
    const deadline = performance.now() + 30_000;
    while (expected.indexing && performance.now() < deadline) {
      await delay(100);
      expected = await read(query);
    }
    assert(!expected.indexing, "fixture transcript index did not settle");
    assert.equal(expected.results.length, query.count);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await read(query), expected);
    }
    const source = getTrackedWorkerCpuSources();
    assert(source.workers.length > 0);
    const workerCpu = async () => {
      assert.equal(source.currentRevision(), source.revision, "worker set changed during sampling");
      const lifetime = new AbortController();
      try {
        // Idle worker handles are unref'ed. Keep the harness alive until the sample settles.
        const usage = await Promise.race([
          Promise.all(source.workers.map((worker) => worker.cpuUsage())),
          delay(5_000, undefined, { signal: lifetime.signal }).then(() => {
            throw new Error("Native worker CPU sample timed out");
          }),
        ]);
        return usage.reduce((sum, used) => {
          assert(used, "could not read native worker CPU");
          return sum + used.user + used.system;
        }, 0);
      } finally {
        lifetime.abort();
      }
    };
    const measured = [];
    for (let sample = 0; sample < samples; sample++) {
      global.gc();
      consumeCpuMicros = consumeCount = 0;
      const load = loadavg();
      const workerBefore = await workerCpu();
      const wall = new Float64Array(iterations);
      const observed = [];
      const allocatedBefore = values.allocation ? getHeapStatistics().total_allocated_bytes : 0;
      const before = process.threadCpuUsage();
      for (let i = 0; i < iterations; i++) {
        const started = performance.now();
        observed.push(await read(query));
        wall[i] = performance.now() - started;
      }
      const cpu = process.threadCpuUsage(before);
      const allocatedBytes = values.allocation
        ? (getHeapStatistics().total_allocated_bytes - allocatedBefore) / iterations
        : undefined;
      const workerCpuMs = ((await workerCpu()) - workerBefore) / 1000 / iterations;
      for (const result of observed) {
        assert.deepEqual(result, expected);
      }
      measured.push({
        sample,
        load,
        cpuMs: (cpu.user + cpu.system) / 1000 / iterations,
        consumeCpuMs: consumeCpuMicros / 1000 / iterations,
        consumeCount: consumeCount / iterations,
        workerCpuMs,
        allocatedBytes,
        wallP95Ms: wall.toSorted()[Math.ceil(iterations * 0.95) - 1]!,
      });
    }
    results.push({
      ...query,
      firstWallMs,
      firstIndexing,
      digest: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
      measured,
    });
  }
  console.log(
    JSON.stringify({
      ownerRef: values["owner-ref"] ?? "working-tree",
      sourceHash: createHash("sha256")
        .update(JSON.stringify([...sources.values()]))
        .digest("hex"),
      ...fixture,
      iterations,
      allocation: Boolean(values.allocation),
      results,
    }),
  );
} finally {
  projection?.dispose();
  release();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
