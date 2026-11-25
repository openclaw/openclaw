// Invalidation owner benchmark: actual sessions.list owner, 500 persisted synthetic rows, 20 recipients,
// 100 mixed queries / 200 retained selection+presentation views, 50 writes/s for 60 s.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-list-invalidation-measure.ts \
//   --state-dir .local/invalidation/run-a --output .local/invalidation/run-a.json
// Use --source-file <baseline/session-list-view-cache.ts> for an identical loader control.
// Run five alternating A1/A2/B triples serially. Separate --profile from timing runs.
// Require exact normalized wire digests and invalidated-view counts, lower invalidation
// time, and no material CPU/allocation/list-tail regression beyond the A/A controls.
// One write can emit multiple facts: report both denominators. Allocation is V8 total
// allocated bytes (including collected objects); CPU is main-thread, excluding workers.
// No socket/model/production-database/workspace latency or throughput claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "source-file": { type: "string" },
    seconds: { type: "string", default: "60" },
    profile: { type: "boolean", default: false },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
assert(global.gc, "Run with --expose-gc");
const seconds = Number(values.seconds);
assert(Number.isSafeInteger(seconds) && seconds > 0);
const root = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
mkdirSync(root);
mkdirSync(path.join(root, "home"));
mkdirSync(path.join(root, "tmp"));
const source = readFileSync(
  values["source-file"] ?? "src/gateway/session-list-view-cache.ts",
  "utf8",
);
registerHooks({
  load(url, ctx, next) {
    const loaded = next(url, ctx);
    return url.endsWith("/src/gateway/session-list-view-cache.ts")
      ? { ...loaded, source: stripTypeScriptTypes(source) }
      : loaded;
  },
});
const cfg: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { main: {} } },
  plugins: { enabled: false },
  gateway: {
    roles: {
      default: "view",
      definitions: {
        view: {
          sessions: { others: "view" },
          agents: "*",
          scopes: ["operator.read", "operator.write"],
        },
      },
    },
  },
};
const configPath = path.join(root, "openclaw.json");
writeFileSync(configPath, JSON.stringify(cfg));
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
const [
  { setRuntimeConfigSnapshot },
  { writeSessionEntry },
  { replaceSessionEntrySync },
  agentDb,
  stateDb,
  { ensureProfileForEmail },
  { prepareUserProfileCatalog },
  { prepareGatewayRecipientProfile },
  { createSessionRowProjection },
  { listProjectedSessions },
  { prepareSessionRowPublicationView },
  { serializeGatewayFrame },
  { createEmptyPluginRegistry },
  { setActivePluginRegistry },
] = await Promise.all([
  import("../../src/config/runtime-snapshot.ts"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts"),
  import("../../src/config/sessions/session-accessor.ts"),
  import("../../src/state/openclaw-agent-db.ts"),
  import("../../src/state/openclaw-state-db.ts"),
  import("../../src/state/user-profiles.ts"),
  import("../../src/state/user-profile-list.ts"),
  import("../../src/gateway/expected-profile.ts"),
  import("../../src/gateway/session-row-projection.ts"),
  import("../../src/gateway/session-utils-list.ts"),
  import("../../src/gateway/session-row-publication.ts"),
  import("../../src/gateway/serialized-json.ts"),
  import("../../src/plugins/registry-empty.ts"),
  import("../../src/plugins/runtime.ts"),
]);
setActivePluginRegistry(createEmptyPluginRegistry());
setRuntimeConfigSnapshot(cfg, cfg);
const profiles = Array.from({ length: 20 }, (_, i) =>
  ensureProfileForEmail(`viewer-${i}@synthetic.example`),
);
await prepareUserProfileCatalog();
const clients = profiles.map((profile, i): GatewayClient => {
  const client: GatewayClient = {
    connId: `connection-${i}`,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "synthetic",
        platform: "node",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserId: profile.id,
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  prepareGatewayRecipientProfile(client);
  return client;
});
const keyFor = (i: number) => `agent:main:synthetic-${i}`;
const entries: SessionEntry[] = Array.from({ length: 500 }, (_, i) => ({
  sessionId: `synthetic-${i}`,
  updatedAt: 1800000000000 + i,
  label: `Synthetic ${i}`,
  visibility: "shared",
  createdActor: { type: "human", source: "profile", id: profiles[i % 20]!.id },
}));
agentDb.runOpenClawAgentWriteTransaction(
  (db) => entries.forEach((entry, i) => writeSessionEntry(db, keyFor(i), entry)),
  { agentId: "main" },
);
let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
const inspector = new Session();
try {
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
  const queries: SessionsListParams[] = Array.from({ length: 100 }, (_, i) => ({
    rowMode: i % 2 ? "sidebar" : "compact",
    limit: 50,
    offset: Math.floor(i / 20) * 50,
    archived: i % 3 ? "all" : false,
    excludeSystem: i % 4 === 0,
  }));
  const revisions: (string | undefined)[] = queries.map(() => undefined);
  const digest = createHash("sha256");
  async function list(i: number, record = false) {
    const result = await listProjectedSessions({
      projection: projection!,
      client: clients[i % 20],
      opts: {
        ...queries[i],
        ifRowsRevision: revisions[i] === undefined ? undefined : `delta:${revisions[i]}`,
      },
      acceptsSerializedJson: true,
    });
    revisions[i] = result.rowsRevision;
    assert.equal(result.count, 50);
    serializeGatewayFrame({ type: "res", id: "list", ok: true, payload: result });
    if (record) {
      let wire = JSON.stringify(
        {
          sessions: result.sessions,
          sharedFacts: result.sharedFacts,
          rowsUnchanged: result.rowsUnchanged,
          rowsDelta: result.rowsDelta && { ...result.rowsDelta, baseRevision: "base" },
        },
        (key, value) => (key === "snapshotAt" ? 1800000000000 : value),
      );
      profiles.forEach((p, j) => {
        wire = wire
          .replaceAll(
            `/api/users/${p.id}/avatar?v=${p.updatedAt}`,
            `/api/users/${p.id}/avatar?v=1800000000000`,
          )
          .replaceAll(p.id, `profile-${j}`);
      });
      digest.update(wire);
    }
    return result;
  }
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 100; i++) {
      await list(i);
    }
  }
  const cache = prepareSessionRowPublicationView(projection)().lists;
  const initialViews = [...cache.values()].length;
  assert.equal(initialViews, 200);
  // Complete optional selected-row backfill before the timed resident stream.
  for (let round = 0; round < 4; round++) {
    await delay(250);
    for (let i = 0; i < 100; i++) {
      await list(i);
    }
  }
  let invalidationMs = 0,
    invalidationCalls = 0,
    resetCalls = 0,
    retired = 0;
  const invalidate = cache.invalidateRows.bind(cache);
  cache.invalidateRows = (key) => {
    const at = performance.now();
    invalidate(key);
    invalidationMs += performance.now() - at;
    invalidationCalls++;
    if (key === undefined) {
      resetCalls++;
    }
  };
  const retire = cache.retireRows.bind(cache);
  cache.retireRows = (view) => {
    retired++;
    return retire(view);
  };
  global.gc();
  await nextTurn();
  const profile = values.profile;
  if (profile) {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const loadStart = loadavg();
  const alloc = getHeapStatistics().total_allocated_bytes;
  const cpu = process.threadCpuUsage();
  const at = performance.now();
  const latencies: number[] = [];
  const changes = seconds * 50;
  let reads = 0;
  for (let tick = 0; tick < changes; tick++) {
    const index = (tick * 17) % 500;
    entries[index] = { ...entries[index]!, inputTokens: tick + 1 };
    replaceSessionEntrySync({ agentId: "main", sessionKey: keyFor(index) }, entries[index]!);
    await projection.ensureMaterialized();
    if (tick % 5 < 2) {
      const started = performance.now();
      await list(reads % 100, true);
      latencies.push(performance.now() - started);
      reads++;
    }
    const remaining = at + (tick + 1) * 20 - performance.now();
    if (remaining > 0) {
      await delay(remaining);
    }
  }
  const elapsedMs = performance.now() - at;
  const used = process.threadCpuUsage(cpu);
  const allocated = getHeapStatistics().total_allocated_bytes - alloc;
  if (profile) {
    const p = await inspector.post("Profiler.stop");
    writeFileSync(`${output}.cpuprofile`, JSON.stringify(p.profile));
    inspector.disconnect();
  }
  latencies.sort((a, b) => a - b);
  const result = {
    seconds,
    changes,
    reads,
    initialViews,
    finalViews: [...cache.values()].length,
    invalidationCalls,
    resetCalls,
    retired,
    invalidationUsPerCall: (invalidationMs / invalidationCalls) * 1000,
    invalidationUsPerWrite: (invalidationMs / changes) * 1000,
    cpuUsPerWrite: (used.user + used.system) / changes,
    allocatedBytesPerWrite: allocated / changes,
    listP50Ms: latencies[Math.floor(reads * 0.5)],
    listP95Ms: latencies[Math.floor(reads * 0.95)],
    listP99Ms: latencies[Math.floor(reads * 0.99)],
    elapsedMs,
    loadStart,
    loadEnd: loadavg(),
    wireDigest: digest.digest("hex"),
    sourceHash: createHash("sha256").update(source).digest("hex"),
  };
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  projection?.dispose();
  inspector.disconnect();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
