/**
 * --surge runs a rate-paced synthetic session event mix at 470 logical events/s,
 * with eight live child sessions, their parents, and list subscribers polling at 10 Hz.
 * Use --sessions 15000 --page-size 100 --clients 6 --operations 4700.
 * --surge-detail instruments present/child/select/freeze/share using the churn probe;
 * run separately from uninstrumented timing and allocation. This uses real prepared
 * event and list owners and loopback WebSockets, without a Gateway process or model.
 * --entry-surge uses four physical agent stores and replaces 40% of logical events
 * with committed metadata changes. The mix is synthetic.
 *
 * Default: warm sessions.list owner benchmark with persisted synthetic rows and
 * recipient policy. No socket, model, or end-to-end Gateway latency claim.
 * Optional projection backfill remains enabled throughout, including warmup.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sidebar-presentation-measure.ts \
 *   --state-dir .local/sidebar/run-1 --output .local/sidebar/run-1.json
 * Add --owner-file <baseline/session-row-presentation.ts> to substitute only that
 * owner at load time. Repeat --source-file <saved/session-utils-display.ts> (original
 * basename required) to substitute additional Gateway/agent owners; sourceHashes records each.
 * --background-processes 50 seeds live registry records across the selected page,
 * split between canonical-key and sessionId scope matching, including agentless records.
 * Alternate baseline/candidate runs (at least five pairs),
 * with matched A/A controls before timing claims. Each run needs a fresh state dir.
 * Use separate --allocations runs for sampled bytes including collected objects;
 * use separate --trace-gc-nvp runs with --gc-log <redirected stdout> for promotion.
 * --max-presentation-bytes-per-call <bytes> adds an opt-in allocation regression budget
 * (requires --allocations). For scratch-fact packing, use 310000 with the default
 * 10k sessions / 100-row pages, 66 clients and 3000 operations; never a timing gate.
 * Timing and GC gates use untraced, unsampled runs. Defaults: 10k rows, 10 clients,
 * two identities, 100-row pages, 1,000 warm reads. --sessions 10 --operations 10
 * is a setup smoke. The clients are in-process recipients, not live sockets.
 * <output>.wire.json captures packed bytes with fixture profile IDs, avatar versions, and snapshotAt
 * normalized; packedGolden compares those bytes across revisions and preserves field order.
 * --page-size 200 --churn replaces one visible row before each measured read;
 * measures full-page packing under writes. Call latency excludes the write;
 * CPU/allocation include it. Use identical churn on both revisions.
 * --repeats N reuses fixture setup, writing <output>.<1-based repeat>.json.
 * --row-mode compact|full measures recipient diagnostics; --sandbox-required
 * selects a role that cannot read the fixture's unsandboxed host workspace.
 * With --barrier-dir <fresh directory> --side base|fix, publish <side>.ready
 * after warmup and wait for <repeat>.<side>.go before each measured repeat.
 * A controller can alternate the two prepared processes without overlapping measured reads.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics } from "node:v8";
import { transformSync } from "esbuild";
import WebSocket, { WebSocketServer } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.ts";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { expandSessionRowFacts } from "../../packages/gateway-protocol/src/session-row-fields.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import { parseAgentSessionKey } from "../../src/routing/session-key.js";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { sessionRowChurnProbe } from "./session-row-churn-probe.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "owner-file": { type: "string" },
    "source-file": { type: "string", multiple: true },
    "gc-log": { type: "string" },
    "barrier-dir": { type: "string" },
    side: { type: "string" },
    repeats: { type: "string", default: "1" },
    sessions: { type: "string", default: "10000" },
    "page-size": { type: "string", default: "100" },
    "row-mode": { type: "string", default: "sidebar" },
    "sandbox-required": { type: "boolean", default: false },
    surge: { type: "boolean", default: false },
    "entry-surge": { type: "boolean", default: false },
    "surge-detail": { type: "boolean", default: false },
    churn: { type: "boolean", default: false },
    clients: { type: "string", default: "10" },
    "background-processes": { type: "string", default: "0" },
    operations: { type: "string", default: "1000" },
    allocations: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    "max-presentation-bytes-per-call": { type: "string" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
assert(global.gc, "run with --expose-gc");
assert(
  !values.allocations || !values["cpu-profile"],
  "Measure CPU attribution and allocation separately",
);
assert(
  values["row-mode"] === "sidebar" ||
    values["row-mode"] === "compact" ||
    values["row-mode"] === "full",
);
const rowMode = values["row-mode"] === "full" ? undefined : values["row-mode"];
const integer = (
  name: "sessions" | "clients" | "operations" | "repeats" | "page-size" | "background-processes",
  min: number,
) => parseStrictIntegerOption({ raw: values[name], label: name, min, fallback: min });
const sessions = integer("sessions", 2);
const backgroundProcesses = integer("background-processes", 0);
const clients = integer("clients", 2);
const operations = integer("operations", 1);
const repeats = integer("repeats", 1);
const allocationBudget =
  values["max-presentation-bytes-per-call"] === undefined
    ? undefined
    : parseStrictIntegerOption({
        raw: values["max-presentation-bytes-per-call"],
        label: "max-presentation-bytes-per-call",
        min: 1,
        fallback: 1,
      });
assert(
  allocationBudget === undefined || values.allocations,
  "allocation budget requires --allocations",
);
const warmCalls = Math.min(operations, Math.max(clients * 5, 1000));
const barrierDir = values["barrier-dir"] && path.resolve(values["barrier-dir"]);
if (barrierDir) {
  assert(values.side === "base" || values.side === "fix", "--barrier-dir requires --side base|fix");
  mkdirSync(barrierDir, { recursive: true });
}
const pageSize = Math.min(integer("page-size", 2), sessions);
assert(!values["entry-surge"] || values.surge, "--entry-surge requires --surge");
const agentIds = values["entry-surge"] ? ["main", "second", "third", "fourth"] : ["main"];
const agentFor = (index: number) => agentIds[Math.floor(index / 150) % agentIds.length]!;
const keyFor = (index: number) =>
  `agent:${agentFor(index)}:sidebar-${index.toString().padStart(5, "0")}`;
const root = path.resolve(values["state-dir"]);
mkdirSync(root);
for (const dir of ["home", "tmp"]) {
  mkdirSync(path.join(root, dir));
}
const output = path.resolve(values.output);
const ownerFile = path.resolve(values["owner-file"] ?? "src/gateway/session-row-presentation.ts");
const ownerSource = readFileSync(ownerFile, "utf8");
const sources = new Map<string, string>();
if (values["owner-file"]) {
  sources.set("session-row-presentation.ts", ownerSource);
}
for (const file of values["source-file"] ?? []) {
  sources.set(path.basename(file), readFileSync(path.resolve(file), "utf8"));
}
const replaced = new Set<string>();
if (sources.size || values["surge-detail"]) {
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      const name = path.basename(url);
      const override =
        url.includes("/src/gateway/") || url.includes("/src/agents/") || url.includes("/src/infra/")
          ? sources.get(name)
          : undefined;
      if (override) {
        replaced.add(name);
      }
      let source = override;
      const instrument =
        values["surge-detail"] &&
        url.includes("/src/gateway/") &&
        [
          "session-row-presentation.ts",
          "session-row-identity.ts",
          "session-utils-list.ts",
          "session-row-child-activity.ts",
        ].includes(name);
      if (instrument) {
        source ??= readFileSync(new URL(url), "utf8");
        const replace = (before: string, after: string) => {
          assert(source!.includes(before), `Missing instrumentation anchor in ${name}`);
          source = source!.replace(before, after);
        };
        source =
          'import { r2Task, sessionRowChurnProbe } from "../../scripts/perf/session-row-churn-probe.js";\n' +
          source;
        if (name === "session-row-identity.ts") {
          replace("export function freezeSessionRow(", "function measuredFreezeSessionRow(");
          source +=
            '\nexport const freezeSessionRow = (...args: Parameters<typeof measuredFreezeSessionRow>) => r2Task("freeze", () => measuredFreezeSessionRow(...args));\n';
        } else if (name === "session-utils-list.ts") {
          replace("const selectPage = () => {", "const measuredSelectPage = () => {");
          replace(
            "    let page: ReturnType<typeof selectPage>;",
            '    const selectPage = () => r2Task("select", measuredSelectPage);\n    let page: ReturnType<typeof selectPage>;',
          );
        } else if (name === "session-row-child-activity.ts") {
          replace(
            '  ): Omit<Contribution, "link"> {',
            '  ): Omit<Contribution, "link"> {\n    sessionRowChurnProbe.count("childContributions");',
          );
        } else {
          replace("  const present = (", "  const measuredPresent = (");
          replace(
            "    const childActivity = projection.readChildActivity(",
            '    const childActivity = r2Task("child", () => projection.readChildActivity(',
          );
          replace(
            "      options.excludedChildKeys ? {} : visibility?.revision,\n    );",
            "      options.excludedChildKeys ? {} : visibility?.revision,\n    ));",
          );
          replace(
            "  return {\n    rowContext: preparedRowContext,",
            '  const present = (...args: Parameters<typeof measuredPresent>) => r2Task("present", () => measuredPresent(...args));\n  return {\n    rowContext: preparedRowContext,',
          );
          replace(
            "export function shareSidebarSessionRows(",
            "function measuredShareSidebarSessionRows(",
          );
          source +=
            '\nexport const shareSidebarSessionRows = (...args: Parameters<typeof measuredShareSidebarSessionRows>) => r2Task("share", () => measuredShareSidebarSessionRows(...args));\n';
        }
      }
      return source === undefined
        ? loaded
        : {
            ...loaded,
            source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
          };
    },
  });
}
const cfg: OpenClawConfig = {
  agents: { ownership: "explicit", entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
  plugins: { enabled: false },
  gateway: {
    roles: {
      default: "view",
      definitions: {
        view: {
          ...(values["sandbox-required"] ? { sandbox: "required" } : {}),
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
    writeGatewayGcTraceMarker(phase, profilePath);
  }
};
marker("identify-start");
global.gc();
marker("identify-stop");
const [
  { setRuntimeConfigSnapshot },
  { writeSessionEntry },
  { replaceSessionEntrySync },
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
  { addSession, createProcessSession, deleteSession },
  { registerAgentRunContext, recordAgentRunModel, clearAgentRunContext, getAgentRunContext },
  { sessionChanges },
  { withPreparedEventRow },
  { prepareSessionRowPublication },
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/config/sessions/session-accessor.js"),
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
  import("../../src/agents/bash-process-registry.js"),
  import("../../src/infra/agent-run-registry.js"),
  import("../../src/sessions/session-row-changes.js"),
  import("../../src/gateway/session-event-prepared-row.js"),
  import("../../src/gateway/session-row-presentation.js"),
]);
assert.equal(replaced.size, sources.size, "source substitution did not run");
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
const sockets: WebSocket[] = [];
const receivers: WebSocket[] = [];
const receivedSequences: number[] = [];
let eventDigests = Array.from({ length: clients }, () => createHash("sha256"));
const server = values.surge ? new WebSocketServer({ host: "127.0.0.1", port: 0 }) : undefined;
if (server) {
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  for (let index = 0; index < clients; index++) {
    const accepted = once(server, "connection");
    const receiver = new WebSocket(`ws://127.0.0.1:${address.port}`);
    receivedSequences[index] = -1;
    receiver.on("message", (bytes) => {
      const frame = JSON.parse(rawDataToString(bytes));
      if (frame.type === "event") {
        assert.equal(frame.payload.sequence, receivedSequences[index]! + 1, "event FIFO");
        receivedSequences[index] = frame.payload.sequence;
        let normalized = JSON.stringify(frame, (key, value) =>
          key === "snapshotAt" ? 1_800_000_000_000 : value,
        );
        for (const [slot, profile] of profiles.entries()) {
          normalized = normalized.replaceAll(
            `/api/users/${profile.id}/avatar?v=${profile.updatedAt}`,
            `/api/users/${profile.id}/avatar?v=1800000000000`,
          );
          normalized = normalized.replaceAll(profile.id, `synthetic-profile-${slot}`);
        }
        eventDigests[index]!.update(normalized);
      }
    });
    await once(receiver, "open");
    const [socket] = await accepted;
    sockets.push(socket);
    receivers.push(receiver);
  }
}
const actualNow = Date.now;
let longestSyncMs = 0;
let longestSyncCpuMs = 0;
let cpuAtLongestSyncMs: number;
function recordSyncSlice(at: number, cpu: NodeJS.CpuUsage) {
  const elapsed = performance.now() - at;
  const used = process.threadCpuUsage(cpu);
  const cpuMs = (used.user + used.system) / 1000;
  longestSyncCpuMs = Math.max(longestSyncCpuMs, cpuMs);
  if (elapsed > longestSyncMs) {
    longestSyncMs = elapsed;
    cpuAtLongestSyncMs = cpuMs;
  }
}
let listCalls = 0;
let unchangedReplies = 0;
let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
const inspector = new Session();
let connected = false;
const collections: { kind: number; ms: number }[] = [];
let start = Infinity;
let end = Infinity;
const observer = new PerformanceObserver((events) =>
  recordGcCollections(events.getEntries(), collections, start, end),
);
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
  for (let index = 0; index < backgroundProcesses; index++) {
    const rowIndex = sessions - 1 - (index % pageSize);
    addSession(
      createProcessSession({
        id: `sidebar-process-${index}`,
        scopeKey: index % 2 ? keyFor(rowIndex) : `sidebar-${rowIndex}`,
        agentId: index % 3 ? "main" : undefined,
        command: "synthetic background work",
        cleanupMs: 60_000,
        startedAt: 1_800_000_000_000,
        maxOutputChars: 10_000,
        totalOutputChars: 0,
        pendingStdoutChars: 0,
        pendingStderrChars: 0,
        pendingOutputDropped: false,
        exited: false,
        truncated: false,
        backgrounded: true,
        cursorKeyMode: "normal",
      }),
    );
  }
  const entryFor = (index: number): InternalSessionEntry => ({
    sessionId: `sidebar-${index}`,
    updatedAt: 1_800_000_000_000 + (values.surge && index % 150 === 0 ? sessions + index : index),
    ...(values.surge && index % 150 !== 0
      ? {
          parentSessionKey: keyFor(index - (index % 150)),
          spawnedBy: keyFor(index - (index % 150)),
          spawnDepth: 1,
          status: "done" as const,
          archivedAt: 1_800_000_000_000,
        }
      : {}),
    label: `Synthetic sidebar row ${index}`,
    visibility: "shared",
    createdActor: {
      type: "human",
      source: "profile",
      id: profiles[index % profiles.length]!.id,
    },
  });
  for (const agentId of agentIds) {
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < sessions; index++) {
          if (agentFor(index) === agentId) {
            writeSessionEntry(database, keyFor(index), entryFor(index));
          }
        }
      },
      { agentId },
    );
  }
  const coldStart = performance.now();
  const coldCpu = process.cpuUsage();
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.prepareSelection();
  await projection.ensureMaterialized();
  const coldUsedCpu = process.cpuUsage(coldCpu);
  const coldProjection = {
    elapsedMs: performance.now() - coldStart,
    cpuMs: (coldUsedCpu.user + coldUsedCpu.system) / 1000,
  };
  if (values.surge) {
    const prepared = projection.withPreparedExactRows.bind(projection);
    const measure = <T>(run: () => T): T => {
      const at = performance.now();
      const cpu = process.threadCpuUsage();
      try {
        return run();
      } finally {
        recordSyncSlice(at, cpu);
      }
    };
    projection.withPreparedExactRows = (queries, consume, options) =>
      prepared(
        (config) => measure(() => queries(config)),
        (read) => measure(() => consume(read)),
        options,
      );
  }
  const revisions: (string | undefined)[] = Array.from({ length: clients });
  const opts: SessionsListParams = {
    rowMode,
    source: "sidebar" as const,
    limit: pageSize,
    archived: "all" as const,
  };
  const hotRows = Array.from({ length: 8 }, (_, index) => {
    const rowIndex = index * 150 + 1;
    return { key: keyFor(rowIndex), agentId: agentFor(rowIndex), entry: entryFor(rowIndex) };
  });
  if (values.surge) {
    assert(sessions >= 1200 && pageSize >= sessions / 150);
    for (const [index, { key, agentId, entry }] of hotRows.entries()) {
      registerAgentRunContext(`surge-${index}`, {
        sessionKey: key,
        agentId,
        sessionId: entry.sessionId,
        projectSessionActive: true,
        registeredAt: 1_800_000_000_000,
      });
    }
  }
  if (values.surge) {
    await projection.withPreparedExactRows(
      () => hotRows,
      () => {},
    );
  }
  async function list(index: number, conditional = true) {
    const slot = index % clients;
    const result = await listProjectedSessions({
      projection: projection!,
      client: recipients[slot],
      opts: { ...opts, ifRowsRevision: conditional ? (revisions[slot] ?? "") : undefined },
      acceptsSerializedJson: true,
    });
    assert.equal(result.count, pageSize);
    assert.equal(result.totalCount, sessions);
    if (result.rowsRevision !== undefined) {
      revisions[slot] = result.rowsRevision;
    }
    // The surge also delivers encoded responses over loopback WebSockets.
    const frame = serializeGatewayFrame({ type: "res", id: "sidebar", ok: true, payload: result });
    sockets[slot]?.send(frame.toString());
    listCalls++;
    if (result.rowsUnchanged) {
      unchangedReplies++;
    }
    return result;
  }
  for (let index = 0; index < warmCalls; index++) {
    await list(index);
  }
  // Only selected rows are materialized. Let their optional empty-transcript
  // backfill acknowledge null before recording the stable warm response.
  const selectedPage = await list(0, false);
  const pendingBackfill = new Set(selectedPage.sessions.map((row) => row.key));
  if (values.surge) {
    for (const { key } of hotRows) {
      pendingBackfill.add(key);
    }
  }
  const backfillDeadline = Date.now() + 120_000;
  while (pendingBackfill.size) {
    // Keep admitting the live page while optional transcript facts settle.
    await list(0);
    for (const key of pendingBackfill) {
      if (
        projection.capture({ agentId: parseAgentSessionKey(key)!.agentId, key })
          ?.retainedDatabaseFacts?.transcriptAssistantMessage === null
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
  const packedGolden: string[] = [];
  const packedSamples = new Map<string, string>();
  const packedDigest = (result: Awaited<ReturnType<typeof list>>) => {
    let bytes = JSON.stringify(
      { sessions: result.sessions, sharedFacts: result.sharedFacts },
      (key, value) => (key === "snapshotAt" ? 1_800_000_000_000 : value),
    );
    for (const [index, profile] of profiles.entries()) {
      bytes = bytes.replaceAll(
        `/api/users/${profile.id}/avatar?v=${profile.updatedAt}`,
        `/api/users/${profile.id}/avatar?v=1800000000000`,
      );
      bytes = bytes.replaceAll(profile.id, `synthetic-profile-${index}`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    packedSamples.set(digest, bytes);
    return digest;
  };
  for (let index = 0; index < clients; index++) {
    const result = await list(index, false);
    const rows = expandSessionRowFacts(result.sessions, result.sharedFacts);
    assert.equal(rows.length, pageSize);
    assert.equal(
      rows.reduce((count, row) => count + (row.backgroundProcessCount ?? 0), 0),
      backgroundProcesses,
    );
    if (!values.surge) {
      assert.equal(rows[0]?.key, keyFor(sessions - 1));
      assert.equal(
        rows[0]?.sharingRole,
        index % profiles.length === (sessions - 1) % profiles.length ? "owner" : "viewer",
      );
    }
    golden.push(createHash("sha256").update(JSON.stringify(rows)).digest("hex"));
    packedGolden.push(packedDigest(result));
  }
  writeFileSync(`${output}.wire.json`, JSON.stringify([...packedSamples.values()]));
  if (values.allocations || values["cpu-profile"]) {
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
    if (values["cpu-profile"]) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
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
    sessionRowChurnProbe.begin("surge", true);
    longestSyncMs = 0;
    longestSyncCpuMs = 0;
    cpuAtLongestSyncMs = 0;
    listCalls = 0;
    unchangedReplies = 0;
    receivedSequences.fill(-1);
    eventDigests = Array.from({ length: clients }, () => createHash("sha256"));
    let fixtureNow = 1_800_000_000_000 + Math.floor(((repeat - 1) * operations * 1000) / 470);
    if (values.surge) {
      Date.now = () => fixtureNow;
    }
    let eventFrames = 0;
    const eventKinds = { delta: 0, activity: 0, model: 0, child: 0, entry: 0 };
    start = performance.now();
    for (let index = 0; index < operations; index++) {
      if (values.surge) {
        // Synthetic mix: 60% chat deltas, 20% activity, 10% model, 10% child run updates.
        // Eight live children plus their parents exercise sixteen active sessions.
        fixtureNow =
          1_800_000_000_000 + Math.floor((((repeat - 1) * operations + index) * 1000) / 470);
        const mutationAt = performance.now();
        const mutationCpu = process.threadCpuUsage();
        const slot = index % hotRows.length;
        const { key, agentId, entry } = hotRows[slot]!;
        const kind = index % 10;
        if (values["entry-surge"] && kind >= 4 && kind < 8) {
          eventKinds.entry++;
          replaceSessionEntrySync(
            { agentId, sessionKey: key },
            { ...entry, label: `Committed metadata ${index}` },
          );
        } else if (kind < 6) {
          eventKinds.delta++;
        } else if (kind < 8) {
          eventKinds.activity++;
          sessionChanges.emit({ sessionKey: key, agentId, scope: "automation" });
        } else if (kind === 8) {
          eventKinds.model++;
          recordAgentRunModel(`surge-${slot}`, {
            provider: "fixture",
            model: `model-${Math.floor(index / 40) % 2}`,
          });
        } else {
          eventKinds.child++;
          registerAgentRunContext(`surge-${slot}`, {
            sessionKey: key,
            sessionId: entry.sessionId,
            agentId,
            projectSessionActive: !getAgentRunContext(`surge-${slot}`)?.projectSessionActive,
          });
        }
        recordSyncSlice(mutationAt, mutationCpu);
        await withPreparedEventRow(projection, { key, agentId }, (read, ancestors) => {
          assert(read);
          const publication = prepareSessionRowPublication(projection!, Date.now(), read);
          for (const [recipientIndex, client] of recipients.entries()) {
            const presentation = publication(client).getPresentation();
            const row = presentation.snapshot({ key, agentId }).row;
            const parents = ancestors?.map((record) => presentation.present(record));
            sockets[recipientIndex]!.send(
              serializeGatewayFrame({
                type: "event",
                event: kind < 6 ? "session.message" : "sessions.changed",
                payload: {
                  session: row,
                  ancestorSessions: parents,
                  sequence: index,
                  ...(kind < 6
                    ? { message: { role: "assistant", content: `Synthetic delta ${index}` } }
                    : {}),
                },
              }).toString(),
            );
            eventFrames++;
          }
        });
        // Subscribers request the current page every 100 ms; events are not reordered.
        if (index % 47 === 0) {
          for (let client = 0; client < clients; client++) {
            await list(client);
          }
        }
        const due = start + ((index + 1) * 1000) / 470;
        if (due > performance.now()) {
          await delay(due - performance.now());
        } else {
          await nextTurn();
        }
        continue;
      }
      if (values.churn) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: keyFor(sessions - 1) },
          {
            sessionId: `sidebar-${sessions - 1}`,
            updatedAt: 1_800_000_000_000 + sessions - 1,
            label: `Changed sidebar row ${index}`,
            visibility: "shared",
            createdActor: {
              type: "human",
              source: "profile",
              id: profiles[(sessions - 1) % profiles.length]!.id,
            },
          },
        );
      }
      const at = performance.now();
      const result = await list(index);
      if (values.churn) {
        assert.equal(result.sessions.length, pageSize);
        assert.equal(result.sessions[0]?.label, `Changed sidebar row ${index}`);
      } else {
        assert.equal(result.rowsUnchanged, true);
      }
      latencies.push(performance.now() - at);
      await nextTurn();
    }
    end = performance.now();
    const { tasks, materializationWork } = sessionRowChurnProbe.snapshot();
    const surgeBreakdown = Object.fromEntries(
      Object.entries(tasks).map(([name, task]) => [
        name,
        {
          calls: task.calls,
          mainThreadMsPer1kEvents: (task.cpuMs * 1000) / operations,
          longestSyncCpuMs: task.maxCpuMs,
          longestSyncMs: task.durations.reduce(
            (longest, duration) => Math.max(longest, duration),
            0,
          ),
          exclusiveMs: task.exclusiveMs,
        },
      ]),
    );
    const measuredLongestSyncMs = longestSyncMs;
    const measuredLongestSyncCpuMs = longestSyncCpuMs;
    const measuredCpuAtLongestSyncMs = cpuAtLongestSyncMs;
    const measuredListCalls = listCalls;
    const measuredUnchangedReplies = unchangedReplies;
    if (values.surge) {
      const deadline = performance.now() + 5000;
      while (receivedSequences.some((sequence) => sequence !== operations - 1)) {
        assert(performance.now() < deadline, "WebSocket event delivery did not drain");
        await delay(1);
      }
    }
    marker("heap-stop", profilePath);
    const usedCpu = process.cpuUsage(cpu);
    const usedThread = process.threadCpuUsage(threadCpu);
    loop.disable();
    if (values["cpu-profile"]) {
      const { profile } = await inspector.post("Profiler.stop");
      writeFileSync(`${repeatOutput}.cpuprofile`, JSON.stringify(profile));
    }
    await nextTurn();
    recordGcCollections(observer.takeRecords(), collections, start, end);
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
    if (values.churn) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: keyFor(sessions - 1) },
        {
          sessionId: `sidebar-${sessions - 1}`,
          updatedAt: 1_800_000_000_000 + sessions - 1,
          label: `Synthetic sidebar row ${sessions - 1}`,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: profiles[(sessions - 1) % profiles.length]!.id,
          },
        },
      );
    }
    const churnPackedGolden: string[] = [];
    for (let index = 0; index < clients; index++) {
      const result = await list(index, false);
      const digest = createHash("sha256")
        .update(JSON.stringify(expandSessionRowFacts(result.sessions, result.sharedFacts)))
        .digest("hex");
      if (!values.churn && !values.surge) {
        assert.equal(digest, golden[index], "warm recipient facts changed without a publication");
      }
      if (values.churn || values.surge) {
        // Replacing the row changes snapshotAt and can regroup shared facts even after
        // its label is restored. Compare these exact normalized bytes across revisions.
        churnPackedGolden.push(packedDigest(result));
      } else {
        assert.equal(packedDigest(result), packedGolden[index], "warm packed wire bytes changed");
      }
    }
    writeFileSync(`${repeatOutput}.wire.json`, JSON.stringify([...packedSamples.values()]));
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
      scope: values.surge
        ? "Real prepared event/list owners over persisted synthetic rows and loopback WebSockets; no Gateway process or model calls"
        : "Real sessions.list owner over persisted synthetic rows; in-process recipients, no sockets or model calls",
      mode: values.allocations
        ? "sampled-allocation"
        : traced
          ? "traced-promotion"
          : "untraced-timing",
      node: process.version,
      sourceHash: createHash("sha256").update(ownerSource).digest("hex"),
      sourceHashes: Object.fromEntries(
        [
          "session-row-child-activity.ts",
          "session-row-presentation.ts",
          "session-list-view-cache.ts",
          "session-utils-list.ts",
          "session-row-prepared-read.ts",
          "session-row-projection-ancestors.ts",
          "session-row-projection-identities.ts",
          "session-row-projection-materialize.ts",
          "session-row-projection-record.ts",
          "session-row-projection.ts",
          "session-utils-display.ts",
          "session-utils-core.ts",
          "session-utils-projection.ts",
          "session-utils-row.ts",
          "bash-process-observation.ts",
          "agent-run-registry-state.ts",
        ].map((name) => [
          name,
          createHash("sha256")
            .update(
              sources.get(name) ??
                readFileSync(
                  path.resolve(
                    name === "bash-process-observation.ts"
                      ? "src/agents"
                      : name === "agent-run-registry-state.ts"
                        ? "src/infra"
                        : "src/gateway",
                    name,
                  ),
                  "utf8",
                ),
            )
            .digest("hex"),
        ]),
      ),
      surge: values.surge
        ? {
            eventKinds,
            agents: agentIds.length,
            eventFrames,
            targetEventsPerSecond: 470,
            longestSyncMs: measuredLongestSyncMs,
            longestSyncCpuMs: measuredLongestSyncCpuMs,
            cpuAtLongestSyncMs: measuredCpuAtLongestSyncMs,
            receivedSequences: [...receivedSequences],
            eventDigests: eventDigests.map((digest) => digest.digest("hex")),
            breakdown: surgeBreakdown,
            materializationWork,
          }
        : undefined,
      sessions,
      clients,
      identities: profiles.length,
      pageSize,
      backgroundProcesses,
      rowMode: values["row-mode"],
      sandboxRequired: values["sandbox-required"],
      operations,
      warmCalls,
      preparedBackfillRows: pageSize,
      coldProjection,
      repeat,
      repeats,
      churn: values.churn,
      counts: {
        calls: measuredListCalls,
        selectedRows: measuredListCalls * pageSize,
        unchangedReplies: measuredUnchangedReplies,
      },
      goldenScope:
        "within-run stability only; includes generated profile IDs and presentation timestamps",
      golden,
      packedGoldenScope:
        "Exact sessions/sharedFacts JSON, with generated profile IDs, avatar versions, and snapshotAt normalized",
      packedGolden,
      churnPackedGolden,
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
    if (allocationBudget !== undefined) {
      assert(
        allocation!.presentationBytesPerCall <= allocationBudget,
        `Presentation allocation ${allocation!.presentationBytesPerCall} bytes/call exceeds ${allocationBudget}`,
      );
    }
  }
} finally {
  Date.now = actualNow;
  for (let index = 0; index < 8; index++) {
    clearAgentRunContext(`surge-${index}`);
  }
  for (const socket of [...sockets, ...receivers]) {
    socket.terminate();
  }
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
  observer.disconnect();
  loop.disable();
  if (connected) {
    inspector.disconnect();
  }
  projection?.dispose();
  for (let index = 0; index < backgroundProcesses; index++) {
    deleteSession(`sidebar-process-${index}`);
  }
  catalog.release();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
