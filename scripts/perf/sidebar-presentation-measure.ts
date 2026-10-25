/**
 * Warm sessions.list owner benchmark, with real persisted synthetic rows and
 * recipient policy. No socket, model, or end-to-end Gateway latency claim.
 * Optional projection backfill remains enabled throughout, including warmup.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sidebar-presentation-measure.ts \
 *   --state-dir .local/sidebar/run-1 --output .local/sidebar/run-1.json
 * Add --owner-file <baseline/session-row-presentation.ts> to substitute only that
 * owner at load time. Alternate baseline/candidate runs (at least five pairs),
 * with matched A/A controls before timing claims. Each run needs a fresh state dir.
 * Use separate --allocations runs for sampled bytes including collected objects;
 * use separate --trace-gc-nvp runs with --gc-log <redirected stdout> for promotion.
 * Timing and GC gates use untraced, unsampled runs. Defaults: 10k rows, 10 clients,
 * two identities, 100-row pages, 1,000 warm reads. --sessions 10 --operations 10
 * is a setup smoke. The clients are in-process recipients, not live sockets.
 * --repeats N reuses fixture setup, writing <output>.<1-based repeat>.json.
 * With --barrier-dir <fresh directory> --side base|fix, publish <side>.ready
 * after warmup and wait for <repeat>.<side>.go before each measured repeat.
 * A controller can alternate the two prepared processes without overlapping measured reads.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics } from "node:v8";
import { expandSessionRowFacts } from "../../packages/gateway-protocol/src/session-row-fields.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "owner-file": { type: "string" },
    "gc-log": { type: "string" },
    "barrier-dir": { type: "string" },
    side: { type: "string" },
    repeats: { type: "string", default: "1" },
    sessions: { type: "string", default: "10000" },
    clients: { type: "string", default: "10" },
    operations: { type: "string", default: "1000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
assert(global.gc, "run with --expose-gc");
const integer = (name: "sessions" | "clients" | "operations" | "repeats", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: name, min, fallback: min });
const sessions = integer("sessions", 2);
const clients = integer("clients", 2);
const operations = integer("operations", 1);
const repeats = integer("repeats", 1);
const warmCalls = Math.min(operations, Math.max(clients * 5, 1000));
const barrierDir = values["barrier-dir"] && path.resolve(values["barrier-dir"]);
if (barrierDir) {
  assert(values.side === "base" || values.side === "fix", "--barrier-dir requires --side base|fix");
  mkdirSync(barrierDir, { recursive: true });
}
const pageSize = Math.min(100, sessions);
const keyFor = (index: number) => `agent:main:sidebar-${index.toString().padStart(5, "0")}`;
const root = path.resolve(values["state-dir"]);
mkdirSync(root);
for (const dir of ["home", "tmp"]) {
  mkdirSync(path.join(root, dir));
}
const output = path.resolve(values.output);
const ownerFile = path.resolve(values["owner-file"] ?? "src/gateway/session-row-presentation.ts");
const ownerSource = readFileSync(ownerFile, "utf8");
let replaced = false;
if (values["owner-file"]) {
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (url.endsWith("/src/gateway/session-row-presentation.ts")) {
        replaced = true;
        return { ...loaded, source: stripTypeScriptTypes(ownerSource) };
      }
      return loaded;
    },
  });
}
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
const traced = process.execArgv.includes("--trace-gc-nvp");
const marker = (phase: string, profilePath?: string) => {
  if (traced) {
    writeSync(
      1,
      `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
    );
  }
};
marker("identify-start");
global.gc();
marker("identify-stop");
const [
  { setRuntimeConfigSnapshot },
  { writeSessionEntry },
  { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync },
  { closeOpenClawStateDatabaseAsync },
  { ensureProfileForEmail },
  { prepareUserProfileCatalog },
  { prepareGatewayRecipientProfile },
  { createSessionRowProjection },
  { listProjectedSessions },
  { serializeGatewayFrame },
  { createEmptyPluginRegistry },
  { setActivePluginRegistry },
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/state/user-profiles.js"),
  import("../../src/state/user-profile-list.js"),
  import("../../src/gateway/expected-profile.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-utils-list.js"),
  import("../../src/gateway/serialized-json.js"),
  import("../../src/plugins/registry-empty.js"),
  import("../../src/plugins/runtime.js"),
]);
assert(!values["owner-file"] || replaced, "owner substitution did not run");
setActivePluginRegistry(createEmptyPluginRegistry());
setRuntimeConfigSnapshot(cfg, cfg);
const profiles = ["alice", "bob"].map((name) =>
  ensureProfileForEmail(`${name}@sidebar.example.test`),
);
const catalog = await prepareUserProfileCatalog();
const recipients: GatewayClient[] = Array.from({ length: clients }, (_, index) => {
  const profile = profiles[index % profiles.length]!;
  const recipient: GatewayClient = {
    connId: `sidebar-${index}`,
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
  prepareGatewayRecipientProfile(recipient);
  return recipient;
});
let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
const inspector = new Session();
let connected = false;
const collections: { kind: number; ms: number }[] = [];
let start = Infinity;
let end = Infinity;
const record = (entries: PerformanceEntry[]) => {
  for (const entry of entries) {
    if (entry.startTime >= start && entry.startTime < end) {
      collections.push({
        kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
};
const observer = new PerformanceObserver((events) => record(events.getEntries()));
const loop = monitorEventLoopDelay({ resolution: 1 });
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((a, b) => a + b, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}
try {
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = 0; index < sessions; index++) {
        writeSessionEntry(database, keyFor(index), {
          sessionId: `sidebar-${index}`,
          updatedAt: 1_800_000_000_000 + index,
          label: `Synthetic sidebar row ${index}`,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: profiles[index % profiles.length]!.id,
          },
        });
      }
    },
    { agentId: "main" },
  );
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.prepareSelection();
  await projection.ensureMaterialized();
  const revisions: (string | undefined)[] = Array.from({ length: clients });
  const opts = {
    rowMode: "sidebar" as const,
    source: "sidebar" as const,
    limit: pageSize,
    archived: "all" as const,
  };
  async function list(index: number, conditional = true) {
    const slot = index % clients;
    const result = await listProjectedSessions({
      projection: projection!,
      client: recipients[slot],
      opts: { ...opts, ifRowsRevision: conditional ? revisions[slot] : undefined },
      acceptsSerializedJson: true,
    });
    assert.equal(result.count, pageSize);
    assert.equal(result.totalCount, sessions);
    revisions[slot] = result.rowsRevision;
    // Exercise the real response encoder without a socket or a retained response backlog.
    serializeGatewayFrame({ type: "res", id: "sidebar", ok: true, payload: result });
    return result;
  }
  for (let index = 0; index < warmCalls; index++) {
    await list(index);
  }
  // Only selected rows are materialized. Let their optional empty-transcript
  // backfill acknowledge null before recording the stable warm response.
  const pendingBackfill = new Set(
    Array.from({ length: pageSize }, (_, index) => keyFor(sessions - 1 - index)),
  );
  const backfillDeadline = Date.now() + 120_000;
  while (pendingBackfill.size) {
    for (const key of pendingBackfill) {
      if (
        projection.capture({ agentId: "main", key })?.retainedDatabaseFacts
          ?.transcriptAssistantMessage === null
      ) {
        pendingBackfill.delete(key);
      }
    }
    assert(Date.now() < backfillDeadline, `Backfill unfinished for ${pendingBackfill.size} rows`);
    if (pendingBackfill.size) {
      await delay(100);
    }
  }
  const golden: string[] = [];
  for (let index = 0; index < clients; index++) {
    const result = await list(index, false);
    const rows = expandSessionRowFacts(result.sessions, result.sharedFacts);
    assert.equal(rows.length, pageSize);
    assert.equal(rows[0]?.key, keyFor(sessions - 1));
    assert.equal(
      rows[0]?.sharingRole,
      index % profiles.length === (sessions - 1) % profiles.length ? "owner" : "viewer",
    );
    golden.push(createHash("sha256").update(JSON.stringify(rows)).digest("hex"));
  }
  if (values.allocations) {
    inspector.connect();
    connected = true;
  }
  if (barrierDir) {
    writeFileSync(
      path.join(barrierDir, `${values.side}.ready`),
      JSON.stringify({ pid: process.pid, repeats }),
      { flag: "wx" },
    );
  }
  for (let repeat = 1; repeat <= repeats; repeat++) {
    if (barrierDir) {
      const go = path.join(barrierDir, `${repeat}.${values.side}.go`);
      const deadline = Date.now() + 30 * 60_000;
      while (!existsSync(go)) {
        assert(Date.now() < deadline, `Timed out waiting for ${go}`);
        await delay(100);
      }
    }
    const repeatOutput = repeats === 1 ? output : `${output}.${repeat}.json`;
    const profilePath = `${repeatOutput}.heapprofile`;
    global.gc();
    // A process may wait while its peer prepares; restore the same warm workload
    // immediately before sampling instead of measuring V8's idle heap shrinkage.
    for (let index = 0; index < warmCalls; index++) {
      assert.equal((await list(index)).rowsUnchanged, true);
    }
    await nextTurn();
    collections.length = 0;
    start = Infinity;
    end = Infinity;
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    observer.observe({ entryTypes: ["gc"] });
    loop.enable();
    await delay(10);
    const loadStart = loadavg();
    const heapSpaces = getHeapSpaceStatistics();
    const cpu = process.cpuUsage();
    const threadCpu = process.threadCpuUsage();
    const latencies: number[] = [];
    marker("heap-start", profilePath);
    loop.reset();
    start = performance.now();
    for (let index = 0; index < operations; index++) {
      const at = performance.now();
      assert.equal((await list(index)).rowsUnchanged, true);
      latencies.push(performance.now() - at);
      await nextTurn();
    }
    end = performance.now();
    marker("heap-stop", profilePath);
    const usedCpu = process.cpuUsage(cpu);
    const usedThread = process.threadCpuUsage(threadCpu);
    loop.disable();
    await nextTurn();
    record(observer.takeRecords());
    observer.disconnect();
    let allocation:
      | {
          totalBytes: number;
          presentationBytes: number;
          viewerBytes: number;
          viewerBytesPerCall: number;
          bytesPerCall: number;
          presentationBytesPerCall: number;
        }
      | undefined;
    if (values.allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      writeFileSync(profilePath, JSON.stringify(profile));
      let totalBytes = 0,
        presentationBytes = 0,
        viewerBytes = 0;
      const visit = (
        node: HeapProfiler.SamplingHeapProfileNode,
        owner = false,
        inViewer = false,
      ) => {
        const active = owner || node.callFrame.url.includes("session-row-presentation");
        const viewer = inViewer || (active && node.callFrame.functionName === "viewer");
        totalBytes += node.selfSize;
        if (viewer) {
          viewerBytes += node.selfSize;
        }
        if (active) {
          presentationBytes += node.selfSize;
        }
        for (const child of node.children) {
          visit(child, active, viewer);
        }
      };
      visit(profile.head);
      allocation = {
        totalBytes,
        presentationBytes,
        viewerBytes,
        viewerBytesPerCall: viewerBytes / operations,
        bytesPerCall: totalBytes / operations,
        presentationBytesPerCall: presentationBytes / operations,
      };
    }
    for (let index = 0; index < clients; index++) {
      const result = await list(index, false);
      const digest = createHash("sha256")
        .update(JSON.stringify(expandSessionRowFacts(result.sessions, result.sharedFacts)))
        .digest("hex");
      assert.equal(digest, golden[index], "warm recipient facts changed without a publication");
    }
    const gc = (kind?: number) =>
      distribution(
        collections
          .filter((entry) => kind === undefined || entry.kind === kind)
          .map((entry) => entry.ms),
      );
    const totalGc = gc();
    const promotion = values["gc-log"]
      ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
      : undefined;
    const result = {
      scope:
        "Real sessions.list owner over persisted synthetic rows; in-process recipients, no sockets or model calls",
      mode: values.allocations
        ? "sampled-allocation"
        : traced
          ? "traced-promotion"
          : "untraced-timing",
      node: process.version,
      sourceHash: createHash("sha256").update(ownerSource).digest("hex"),
      sessions,
      clients,
      identities: profiles.length,
      pageSize,
      operations,
      warmCalls,
      preparedBackfillRows: pageSize,
      repeat,
      repeats,
      counts: {
        calls: operations,
        selectedRows: operations * pageSize,
        unchangedReplies: operations,
      },
      goldenScope:
        "within-run stability only; includes generated profile IDs and presentation timestamps",
      golden,
      loadStart,
      heapSpaces,
      loadEnd: loadavg(),
      elapsedMs: end - start,
      cpuMsPerCall: (usedCpu.user + usedCpu.system) / 1000 / operations,
      mainCpuMsPerCall: (usedThread.user + usedThread.system) / 1000 / operations,
      latency: distribution(latencies),
      allocation,
      gc: {
        total: totalGc,
        msPerCall: totalGc.totalMs / operations,
        minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
        major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
      },
      promotion: promotion
        ? { ...promotion, bytesPerCall: promotion.promotedBytes / operations }
        : undefined,
      loop: {
        samples: loop.count,
        p95Ms: loop.percentile(95) / 1e6,
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
      },
    };
    writeFileSync(repeatOutput, `${JSON.stringify(result, null, 2)}\n`);
    writeSync(1, `${JSON.stringify(result)}\n`);
  }
} finally {
  observer.disconnect();
  loop.disable();
  if (connected) {
    inspector.disconnect();
  }
  projection?.dispose();
  catalog.release();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
