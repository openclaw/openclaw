/**
 * Resident-row owner proof over persisted Team-shaped synthetic state, not a live Gateway.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-retention-measure.ts \
 *   --state-dir .local/row-retention/candidate --sessions 10800 --page-size 1000 \
 *   --iterations 3000 --mode timing
 * Repeat with --mode allocation in a fresh state directory; timing and allocation are separate.
 * Compare baseline with --owner-file <base/session-row-presentation.ts> and
 * --serialization-file <base/session-row-serialization.ts> and
 * --cache-file <base/session-list-view-cache.ts>. Alternate arms; never reuse state.
 * Index retention changes can use --identities-file <base/session-row-projection-identities.ts>.
 * projectionHeapDelta includes projection initialization and its dependencies after fixture setup.
 * Measure a bounded 1,000-row unarchived resident page over 10,800 stored sessions; do not bypass the
 * projection owner's archive/preparation bounds to materialize the entire inventory.
 * Compact page preparation precedes measurement. Cold sidebar cost includes fact sharing/encoding;
 * warm 100-row lists exercise transport encoding in process. No socket or model-turn claim.
 * Retained heap is a post-GC process delta, not an additive field-size attribution. Cached raw
 * encoding bytes are the owner's conservative UTF-16 accounting, not V8 string self-size.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "10800" },
    "page-size": { type: "string", default: "1000" },
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
    "owner-file": { type: "string" },
    "serialization-file": { type: "string" },
    "cache-file": { type: "string" },
    "identities-file": { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name a fresh synthetic directory");
assert(values.mode === "timing" || values.mode === "allocation");
assert(global.gc, "Run with --expose-gc");
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "sessions",
  min: 100,
  fallback: 10800,
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 3000,
});
const pageSize = Math.min(
  sessions,
  parseStrictIntegerOption({
    raw: values["page-size"],
    label: "page-size",
    min: 2,
    fallback: 1000,
  }),
);
const overrides = new Map<string, { source: string; loaded: boolean }>();
for (const [flag, name] of [
  ["owner-file", "session-row-presentation"],
  ["serialization-file", "session-row-serialization"],
  ["cache-file", "session-list-view-cache"],
  ["identities-file", "session-row-projection-identities"],
] as const) {
  if (values[flag]) {
    overrides.set(`/src/gateway/${name}.ts`, {
      source: readFileSync(path.resolve(values[flag]), "utf8"),
      loaded: false,
    });
  }
}
if (overrides.size) {
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      for (const [suffix, replacement] of overrides) {
        if (url.endsWith(suffix)) {
          replacement.loaded = true;
          return { ...loaded, source: stripTypeScriptTypes(replacement.source) };
        }
      }
      return loaded;
    },
  });
}
const root = path.resolve(values["state-dir"]);
const anchor = Date.UTC(2026, 9, 25);
const { generateTeamShapeStressFixture } = await import("./team-shape-stress-fixture.ts");
const fixture = await generateTeamShapeStressFixture({
  stateDir: root,
  port: 40986,
  seed: 316,
  now: anchor,
  sessions,
  transcriptMiB: 0,
});
process.env = { ...fixture.env };
const cfg: OpenClawConfig = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
const [
  config,
  projections,
  lists,
  publication,
  serialization,
  frames,
  foreground,
  plugins,
  registry,
  agentDb,
  stateDb,
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-utils-list.js"),
  import("../../src/gateway/session-row-publication.js"),
  import("../../src/gateway/session-row-serialization.js"),
  import("../../src/gateway/serialized-json.js"),
  import("../../src/gateway/session-projection-work.js"),
  import("../../src/plugins/runtime.js"),
  import("../../src/plugins/registry-empty.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
]);
for (const [name, replacement] of overrides) {
  assert(replacement.loaded, `Override not loaded: ${name}`);
}
config.setRuntimeConfigSnapshot(cfg);
plugins.setActivePluginRegistry(registry.createEmptyPluginRegistry());
const release = foreground.retainSessionListForegroundWork();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
}
const realNow = Date.now;
Date.now = () => anchor;
let projection: Awaited<ReturnType<typeof projections.createSessionRowProjection>> | undefined;
const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
async function measure(name: string, work: () => Promise<void>) {
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadStart = loadavg();
  const started = performance.now();
  const cpu = process.threadCpuUsage();
  await work();
  const used = process.threadCpuUsage(cpu);
  const elapsedMs = performance.now() - started;
  let allocatedBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = sampledBytes(profile.head);
    writeFileSync(path.join(root, `${name}.heapprofile`), JSON.stringify(profile));
  }
  return {
    elapsedMs,
    mainThreadCpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    loadStart,
    loadEnd: loadavg(),
  };
}
try {
  await nextTurn();
  global.gc();
  const projectionHeapBefore = process.memoryUsage().heapUsed;
  projection = await projections.createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
  await nextTurn();
  global.gc();
  const projectionHeapDelta = process.memoryUsage().heapUsed - projectionHeapBefore;
  const read = (rowMode: "compact" | "sidebar", limit: number) =>
    lists.listProjectedSessions({
      projection: projection!,
      opts: { rowMode, archived: false, limit },
      acceptsSerializedJson: true,
    });
  // Prepare the bounded selected page through the real list owner before presentation.
  const compactCount = (await read("compact", pageSize)).count;
  assert(compactCount > 0);
  await nextTurn();
  global.gc();
  const heapBefore = process.memoryUsage();
  let coldResult: Awaited<ReturnType<typeof read>> | undefined;
  const cold = await measure("cold", async () => {
    coldResult = await read("sidebar", pageSize);
    frames.serializeGatewayFrame({ type: "res", id: "retention", ok: true, payload: coldResult });
  });
  assert(coldResult && coldResult.count === compactCount);
  await nextTurn();
  global.gc();
  const heapAfter = process.memoryUsage();
  // Read the list owner's actual retained vector; cold archive rows can leave the
  // projection roster after their preparation scope without retiring this presentation.
  const coldRows = coldResult.sessions;
  const retainedView = [
    ...publication.prepareSessionRowPublicationView(projection)().lists.values(),
  ].find(
    (view) =>
      view.rows?.length === coldRows.length &&
      view.rows.every(
        (row, index) => row.rowMode === "sidebar" && row.key === coldRows[index]!.key,
      ),
  );
  assert(retainedView?.rows, "Measured sidebar page must remain in the list owner's cache");
  const residentRows = retainedView.rows.length;
  const rawEncodingBytes = retainedView.rows.reduce(
    (bytes, row) => bytes + serialization.sessionRowEncodingBytes(row),
    0,
  );
  const retainedViewAccounting = {
    bytes: retainedView.bytes,
    historyRefs: retainedView.historyRefs,
  };
  // State paths and the owner's random revision token vary across fresh processes.
  assert(coldResult.rowsRevision);
  const wire = frames
    .serializeGatewayFrame({
      type: "res",
      id: "retention",
      ok: true,
      payload: { ...coldResult, rowsRevision: "<revision>" },
    })
    .toString();
  const normalizedWire = wire.split(root).join("<state>");
  writeFileSync(path.join(root, "wire.json"), normalizedWire);
  const digest = createHash("sha256").update(normalizedWire).digest("hex");
  const warmLimit = Math.min(100, compactCount);
  for (let index = 0; index < 100; index++) {
    await read("sidebar", warmLimit);
  }
  const warm = await measure("warm", async () => {
    for (let index = 0; index < iterations; index++) {
      const result = await read("sidebar", warmLimit);
      frames.serializeGatewayFrame({ type: "res", id: "warm", ok: true, payload: result });
    }
  });
  const result = {
    scope:
      "Real persisted Team-shaped session-list owner; no live Gateway, sockets, plugins or model turns",
    mode: values.mode,
    node: process.version,
    sessions,
    pageSize,
    residentRows,
    returnedRows: coldResult.count,
    iterations,
    warmLimit,
    cold,
    warm,
    heapBefore,
    heapAfter,
    projectionHeapDelta,
    retainedHeapDelta: heapAfter.heapUsed - heapBefore.heapUsed,
    retainedHeapPer1000Rows: ((heapAfter.heapUsed - heapBefore.heapUsed) * 1000) / residentRows,
    rawEncodingBytes,
    retainedViewAccounting,
    rawEncodingBytesPer1000Rows: (rawEncodingBytes * 1000) / residentRows,
    wireDigest: digest,
    sourceHashes: Object.fromEntries(
      [
        "session-row-presentation",
        "session-row-serialization",
        "session-list-view-cache",
        "session-row-projection-identities",
      ].map((name) => [
        name,
        createHash("sha256")
          .update(
            overrides.get(`/src/gateway/${name}.ts`)?.source ??
              readFileSync(`src/gateway/${name}.ts`, "utf8"),
          )
          .digest("hex"),
      ]),
    ),
  };
  writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  Date.now = realNow;
  projection?.dispose();
  release();
  if (values.mode === "allocation") {
    inspector.disconnect();
  }
  config.clearRuntimeConfigSnapshot();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
