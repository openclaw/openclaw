// Real recall owner and transcript worker, synthetic resident roster; no transport/model claim.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-recall-measure.ts \
//   --state-dir <new-directory> --sessions 600 --keys 130 [--owner-ref <baseline-sha>]
// Reuse the fixture serially with --reuse; alternate fresh baseline/candidate processes.
// Acceptance: identical results, one preparation per candidate batch, lower main-thread
// CPU and sampled allocation, no reproducible >20% latency regression; >=5 samples + A/A.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
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
const ownerPath = "src/gateway/server-methods/sessions-search-recall.ts";
const ownerUrl = new URL(`../../${ownerPath}`, import.meta.url);
const source = values["owner-ref"]
  ? execFileSync("git", ["show", `${values["owner-ref"]}:${ownerPath}`], { encoding: "utf8" })
  : readFileSync(ownerUrl, "utf8");
if (values["owner-ref"]) {
  registerHooks({
    load(url, context, next) {
      return url === ownerUrl.href
        ? { format: "module-typescript", source, shortCircuit: true }
        : next(url, context);
    },
  });
}
const anchor = Date.UTC(2026, 10, 1);
const configPath = path.join(root, "openclaw.json");
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: { main: { workspace: path.join(root, "workspace") } },
    defaults: { systemAgent: { agentId: "main" } },
  },
  tools: { sessions: { visibility: "self" } },
  plugins: { enabled: false },
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
const inspector = new Session();
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
      transcriptBytes: 0,
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
          { now: anchor + i, message: { role: "user", content: "recallbenchmark needle" } },
        ],
      });
    }
    writeFileSync(path.join(root, "fixture.json"), JSON.stringify({ sessions, keys }));
  }
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "fixture.json"), "utf8")), {
    sessions,
    keys,
  });
  const { createSessionRowProjection } =
    await import("../../src/gateway/session-row-projection.js");
  const { searchRecallSessionTranscripts } =
    await import("../../src/gateway/server-methods/sessions-search-recall.js");
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
  assert(projection.selectEntries({ sortBy: null }).length >= sessions);
  // Self visibility forces the worker to authorize every matching key before concluding.
  const read = async () => {
    let published: SessionsSearchResult | undefined;
    const historicalResult: unknown = await searchRecallSessionTranscripts({
      projection: projection!,
      query: "recallbenchmark",
      limit: 25,
      recall: { requesterAgentId: "main", requesterSessionKey: "agent:main:unmatched-requester" },
      onResult: (result) => {
        published = result;
      },
    });
    // --owner-ref can load a historical owner that returned its page instead of publishing it.
    return published ?? historicalResult;
  };
  const coldStart = performance.now();
  const expected = await read();
  const coldMs = performance.now() - coldStart;
  assert.deepEqual(expected, { results: [] });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await read(), expected);
  }
  const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
  inspector.connect();
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    global.gc();
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const load = loadavg(),
      before = process.threadCpuUsage(),
      started = performance.now();
    let last: Awaited<ReturnType<typeof read>> = expected;
    for (let i = 0; i < iterations; i++) {
      last = await read();
    }
    const elapsed = performance.now() - started,
      cpu = process.threadCpuUsage(before);
    const profile = values.allocation
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    assert.deepEqual(last, expected);
    results.push({
      sample,
      load,
      wallMs: elapsed / iterations,
      cpuMs: (cpu.user + cpu.system) / 1000 / iterations,
      allocatedBytes: profile ? bytes(profile.head) / iterations : undefined,
    });
    if (profile) {
      writeFileSync(path.join(root, "last.heapprofile"), JSON.stringify(profile));
    }
  }
  console.log(
    JSON.stringify({
      ownerRef: values["owner-ref"] ?? "working-tree",
      sourceHash: createHash("sha256").update(source).digest("hex"),
      sessions,
      keys,
      iterations,
      allocation: Boolean(values.allocation),
      coldMs,
      results,
    }),
  );
} finally {
  inspector.disconnect();
  projection?.dispose();
  release();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
