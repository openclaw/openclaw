// Owner-level Team-shaped list workload; transport/tool-turn proof stays in team-shape-stress.ts.
// Run on an approved quiet host with --expose-gc --import ./scripts/tsx.mjs.
// --collector-presentation adds prepared event rows for an unrestricted operator.
// --list-shape sidebar|full|search|agent|mixed isolates warm list allocation and CPU per shape.
// Shape mode seeds --sessions rows across --agents (default 8); mixed keeps the filter/page mix.
// --reuse-fixture reopens a completed shape run; keep sessions/agents/list-shape unchanged.
// Reused directories are serial-only. Compare revisions with separate timing/allocation passes.
// --list-shape runtime-search exercises cold runtime-label rejection; --acp-rows gives one
// third of rows persisted ACP ownership. --source-ref pins runtime owners to a Git revision.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import type {
  GatewaySessionRow,
  SessionsListResult,
} from "../../src/gateway/session-utils.types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeStressFixture } from "./team-shape-stress-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "10800" },
    agents: { type: "string", default: "8" },
    iterations: { type: "string", default: "1200" },
    warmup: { type: "string", default: "48" },
    "updates-per-list": { type: "string", default: "33" },
    mode: { type: "string", default: "timing" },
    "running-candidates": { type: "boolean", default: false },
    reconciliation: { type: "boolean", default: false },
    "metadata-churn": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    golden: { type: "string" },
    "sort-rows": { type: "string" },
    "sort-workload": { type: "boolean", default: false },
    "collector-presentation": { type: "boolean", default: false },
    "search-workload": { type: "boolean", default: false },
    "search-profile": { type: "boolean", default: false },
    "list-shape": { type: "string" },
    "reuse-fixture": { type: "boolean", default: false },
    "acp-rows": { type: "boolean", default: false },
    "source-ref": { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name a new synthetic directory");
assert(values.mode === "timing" || values.mode === "allocation" || values.mode === "verify");
assert(!values["cpu-profile"] || values.mode === "timing", "Separate CPU and heap sampling");
assert(global.gc, "Run with --expose-gc");
// Pin only the runtime projection owners; fixture, transport, and measurement stay identical.
if (values["source-ref"]) {
  const sources = new Map(
    [
      "src/agents/agent-runtime-metadata.ts",
      "src/gateway/session-utils-projection.ts",
      "src/gateway/session-utils-model.ts",
      "src/gateway/session-utils-row.ts",
      "src/gateway/worker-environments/placement-session-runtime.ts",
      "src/gateway/session-row-model-facts.ts",
      "src/gateway/session-row-projection-materialize.ts",
      "src/gateway/session-utils-list.ts",
    ].map((file) => [
      new URL(`../../${file}`, import.meta.url).href,
      execFileSync("git", ["show", `${values["source-ref"]}:${file}`], { encoding: "utf8" }),
    ]),
  );
  registerHooks({
    load(url, context, nextLoad) {
      const source = sources.get(url);
      return source === undefined
        ? nextLoad(url, context)
        : { format: "module-typescript", source, shortCircuit: true };
    },
  });
}
const integer = (
  name: "sessions" | "agents" | "iterations" | "warmup" | "updates-per-list",
  min = 1,
) => parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const sessions = integer("sessions", values["list-shape"] ? 200 : 100);
const agents = integer("agents", 4);
const iterations = integer("iterations");
const warmup = integer("warmup");
const updatesPerList = integer("updates-per-list", 0);
const root = path.resolve(values["state-dir"]);
const presentationSourceHash = createHash("sha256")
  .update(readFileSync(new URL("../../src/gateway/session-row-presentation.ts", import.meta.url)))
  .digest("hex");
const filterSourceHash = createHash("sha256")
  .update(readFileSync(new URL("../../src/gateway/session-list-filters.ts", import.meta.url)))
  .digest("hex");
const anchor = Date.UTC(2026, 9, 25);
const siblingSessions = values["list-shape"] ? Math.floor(sessions / (agents * 2)) : 0;
if (values["reuse-fixture"]) {
  const previous = JSON.parse(readFileSync(path.join(root, "result.json"), "utf8"));
  assert.equal(previous.sessions, sessions);
  assert.equal(previous.agents, agents);
  assert.equal(previous.listShape, values["list-shape"]);
  assert.equal(previous.acpRows === true, values["acp-rows"]);
  assert(values["list-shape"], "Reuse requires a completed shape workload");
  assert(
    !previous.metadataChurn &&
      !previous.reconciliation &&
      previous.updatesPerList === 0 &&
      !values["metadata-churn"] &&
      !values.reconciliation &&
      updatesPerList === 0,
    "Reuse requires non-mutating runs with --updates-per-list 0",
  );
}
const fixture = values["reuse-fixture"]
  ? {
      summary: JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8")),
      env: {
        ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
          startupTrace: false,
        }),
        OPENCLAW_STATE_DIR: root,
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        USERPROFILE: path.join(root, "home"),
        OPENCLAW_PROFILE: "team-shape-40984",
        OPENCLAW_SKIP_CHANNELS: "1",
      },
    }
  : await generateTeamShapeStressFixture({
      stateDir: root,
      port: 40984,
      seed: 224,
      now: anchor,
      sessions: sessions - siblingSessions * (agents - 1),
      transcriptMiB: 0,
    });
process.env = { ...fixture.env };
const cfg: OpenClawConfig = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
const siblings = Array.from(
  { length: agents - 1 },
  (_, index) =>
    ["reviewer", "researcher", "planner", "builder", "tester", "writer", "helper"][index] ??
    `synthetic-${index + 1}`,
);
if (siblingSessions && !values["reuse-fixture"]) {
  for (const agentId of siblings) {
    cfg.agents!.entries![agentId] = { workspace: path.join(root, "workspace", agentId) };
  }
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
}
const [
  config,
  memory,
  registry,
  publications,
  sessionEntries,
  changes,
  projections,
  lists,
  foreground,
  plugins,
  pluginRegistry,
  agentDb,
  stateDb,
  workMetrics,
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/agents/subagents/registry/subagent-registry-memory.js"),
  import("../../src/infra/agent-run-registry.js"),
  import("../../src/agents/subagents/registry/subagent-registry-publication.js"),
  import("../../src/config/sessions/session-accessor.js"),
  import("../../src/sessions/session-row-changes.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-utils-list.js"),
  import("../../src/gateway/session-projection-work.js"),
  import("../../src/plugins/runtime.js"),
  import("../../src/plugins/registry-empty.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/infra/gateway-work-metrics.js"),
]);
const { filterSessionEntries } = await import("../../src/gateway/session-list-filters.js");
if (values["search-workload"]) {
  const main = cfg.agents?.entries?.main;
  assert(main);
  main.identity = { name: "Synthetic Explorer" };
  main.model = "openai/gpt-4.1";
}
config.setRuntimeConfigSnapshot(cfg);
if (siblingSessions && !values["reuse-fixture"]) {
  const { writeSessionEntry } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
  for (const agentId of siblings) {
    agentDb.runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < siblingSessions; index++) {
          writeSessionEntry(database, `agent:${agentId}:dashboard:fixture-${index}`, {
            sessionId: `${agentId}-${index}`,
            updatedAt: anchor - index * 1000,
            label: `Synthetic ${agentId} dashboard ${index}`,
            status: "done",
            ...(index % 5 === 0 ? { archivedAt: anchor - index * 1000 } : {}),
          });
        }
      },
      { agentId },
    );
  }
}
plugins.setActivePluginRegistry(pluginRegistry.createEmptyPluginRegistry());
const releaseForeground = foreground.retainSessionListForegroundWork();
const inspector = new Session();
let connected = false;
let projection: Awaited<ReturnType<typeof projections.createSessionRowProjection>> | undefined;
const claims = new Map<string, string>();
const active: SubagentRunRecord[] = [];
const realNow = Date.now;
let clock = anchor;
Date.now = () => clock;

const cases: SessionsListParams[] = [];
const profileId = "team-shape-profile-0";
const viewer: GatewayClient | undefined =
  values["sort-workload"] || values["collector-presentation"]
    ? {
        connect: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "openclaw-control-ui",
            version: "bench",
            platform: "bench",
            mode: "webchat",
          },
          role: "operator",
          scopes: [
            "operator.read",
            "operator.write",
            ...(values["collector-presentation"] ? ["operator.admin"] : []),
          ],
        },
        authenticatedUserProfile: {
          profileId,
          displayName: null,
          hasAvatar: false,
          updatedAt: anchor,
        },
        preparedSessionProfile: { profileId, aliases: new Set([profileId]), role: null },
      }
    : undefined;
for (const archived of [false, true, "all"] as const) {
  for (const agentId of ["main", undefined]) {
    for (const offset of [0, 50]) {
      cases.push({
        source: "sidebar",
        rowMode: "sidebar",
        agentId,
        configuredAgentsOnly: true,
        limit: 100,
        offset,
        archived,
        excludeDock: true,
      });
    }
  }
}
cases.push(
  { source: "agent-roster", rowMode: "sidebar", archived: "all", limit: 50 },
  {
    source: "agent-roster",
    rowMode: "sidebar",
    archived: "all",
    limit: 50,
    includeOwnerSessionCounts: true,
  },
  { source: "sessions-page", rowMode: "compact", archived: "all", includePeople: true, limit: 50 },
  { source: "sessions-page", agentId: "reviewer", limit: 50 },
);
if (values["sort-workload"]) {
  cases.push(
    { source: "sidebar", rowMode: "sidebar", ownerFirst: true },
    { source: "sidebar", rowMode: "sidebar", involvingMe: true },
    { source: "sidebar", rowMode: "sidebar", activeMinutes: 7 * 24 * 60 },
    { source: "sidebar", rowMode: "sidebar", sortBy: "activity" },
    { source: "sidebar", rowMode: "sidebar", sortBy: "lastInteractionAt" },
  );
  for (const query of cases) {
    query.limit = 200;
  }
}

if (values["running-candidates"]) {
  cases.splice(0, cases.length, {
    source: "agent-roster",
    rowMode: "sidebar",
    archived: "all",
    limit: 50,
    includeOwnerSessionCounts: true,
    excludeSubagents: true,
  });
}

if (values["search-workload"]) {
  cases.length = 0;
  for (const search of [
    "investigation 123",
    "Explorer",
    "gpt-4.1",
    "running",
    "idle",
    "zz-no-match",
  ]) {
    cases.push({
      source: "agent-roster",
      rowMode: "sidebar",
      archived: "all",
      limit: 50,
      search,
      ...(values["search-profile"] ? { involvingProfileId: profileId } : {}),
    });
  }
}

if (values.mode === "verify") {
  let seed = 224;
  const choose = <T>(items: readonly T[]): T => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return items[seed % items.length]!;
  };
  for (let index = 0; index < 96; index++) {
    cases.push({
      source: choose(["sidebar", "agent-roster", "dashboard"] as const),
      rowMode: choose(["sidebar", "compact", "dashboard"] as const),
      agentId: choose([undefined, "main", "reviewer", "researcher"]),
      archived: choose([false, true, "all"] as const),
      limit: choose([1, 7, 25, 100]),
      offset: choose([0, 1, 49, 100, 500, 5000]),
      sortBy: choose(["updatedAt", "lastInteractionAt", "activity"] as const),
      activeMinutes: choose([undefined, 1, 60]),
      configuredAgentsOnly: choose([false, true]),
      includePeople: choose([false, true]),
      includeOwnerSessionCounts: choose([false, true]),
      excludeSubagents: choose([false, true]),
      excludeCron: choose([false, true]),
      includeGlobal: choose([false, true]),
      includeUnknown: choose([false, true]),
    });
  }
}

if (values["list-shape"] && values["list-shape"] !== "mixed") {
  const shapes: Record<string, SessionsListParams> = {
    sidebar: { source: "sidebar", rowMode: "sidebar", limit: 100, archived: false },
    full: { source: "sessions-page", limit: 100, archived: "all" },
    search: { source: "sessions-page", search: "dashboard", limit: 100, archived: "all" },
    "runtime-search": { source: "sessions-page", search: "openclaw", limit: 100, archived: "all" },
    agent: { source: "sessions-page", agentId: "reviewer", limit: 100, archived: false },
  };
  const query = shapes[values["list-shape"]];
  assert(query, "Unknown --list-shape");
  cases.splice(0, cases.length, query);
}

function canonicalResult(result: SessionsListResult | GatewaySessionRow): string {
  const omitted = new Set(["ts", "rowsRevision", "rowRevision", "runtimeMs", "snapshotAt"]);
  return JSON.stringify(result, (key, value: unknown) => {
    if (omitted.has(key)) {
      return undefined;
    }
    if (typeof value === "string") {
      return value.replaceAll(root, "<synthetic-state>");
    }
    return value;
  });
}

function sampledBytes(profile: HeapProfiler.SamplingHeapProfile) {
  let total = 0;
  let prepared = 0;
  let roster = 0;
  let list = 0;
  let sort = 0;
  let comparator = 0;
  const visit = (
    node: HeapProfiler.SamplingHeapProfileNode,
    inPrepared = false,
    inRoster = false,
    inList = false,
    inSort = false,
    inComparator = false,
  ) => {
    const preparedFrame = inPrepared || node.callFrame.functionName === "withPreparedExactRows";
    const rosterFrame = inRoster || node.callFrame.functionName === "withAgentRosterFactsBatch";
    const listFrame = inList || node.callFrame.functionName === "listProjectedSessions";
    const sortFrame = inSort || node.callFrame.functionName === "sortAndLimitSessionEntries";
    const comparatorFrame =
      inComparator || node.callFrame.functionName === "compareSessionEntryPairs";
    total += node.selfSize;
    prepared += preparedFrame ? node.selfSize : 0;
    roster += rosterFrame ? node.selfSize : 0;
    list += listFrame ? node.selfSize : 0;
    sort += sortFrame ? node.selfSize : 0;
    comparator += comparatorFrame ? node.selfSize : 0;
    for (const child of node.children) {
      visit(child, preparedFrame, rosterFrame, listFrame, sortFrame, comparatorFrame);
    }
  };
  visit(profile.head);
  return { total, prepared, roster, list, sort, comparator };
}

function sampledCpu(profile: Profiler.Profile) {
  const targets = new Set([
    "withPreparedExactRows",
    "withAgentRosterFactsBatch",
    "selectPage",
    "matchesSearch",
    "filterSessionEntries",
    "matchesSessionArchiveFilter",
    "readSessionRowModelFacts",
    "prepareSessionRowModelSearch",
    "resolveGatewaySessionThinkingProjectionInternal",
    "resolveAvailableAgentHarnessPolicy",
    "projectGatewaySessionRunState",
  ]);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map(
    profile.nodes.flatMap((node) => (node.children ?? []).map((id) => [id, node.id] as const)),
  );
  const selfMicros: Record<string, number> = {};
  const inclusiveMicros: Record<string, number> = {};
  const weights = new Map<number, number>();
  for (const [index, id] of (profile.samples ?? []).entries()) {
    weights.set(id, (weights.get(id) ?? 0) + (profile.timeDeltas?.[index] ?? 0));
  }
  for (const [id, weight] of weights) {
    const seen = new Set<string>();
    let current: number | undefined = id;
    while (current !== undefined) {
      const frame = nodes.get(current)?.callFrame;
      const name = frame?.functionName;
      if (
        name &&
        (targets.has(name) ||
          (name === "entries" && frame.url.endsWith("/session-row-selection.ts")))
      ) {
        seen.add(name);
        if (current === id) {
          selfMicros[name] = (selfMicros[name] ?? 0) + weight;
        }
      }
      current = parents.get(current);
    }
    for (const name of seen) {
      inclusiveMicros[name] = (inclusiveMicros[name] ?? 0) + weight;
    }
  }
  return { selfMicros, inclusiveMicros };
}

try {
  projection = await projections.createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
  if (values["acp-rows"]) {
    const { writeAcpSessionMetaForMigration } =
      await import("../../src/acp/runtime/session-meta.js");
    const { buildAcpDatabaseSessionKey } =
      await import("../../src/acp/runtime/session-meta-keys.js");
    const entries = projection.selectEntries().toSorted((a, b) => a.key.localeCompare(b.key));
    stateDb.runOpenClawStateWriteTransaction((database) => {
      for (const [index, row] of entries.entries()) {
        if (index % 3 || !row.entry) {
          continue;
        }
        writeAcpSessionMetaForMigration({
          database,
          sessionKey: buildAcpDatabaseSessionKey(row.key, row.agentId),
          sessionId: row.entry.sessionId,
          lifecycleRevision: row.entry.lifecycleRevision,
          meta: {
            backend: "acpx",
            agent: row.agentId,
            runtimeSessionName: row.key,
            mode: "persistent",
            state: "idle",
            lastActivityAt: anchor,
          },
        });
      }
    });
    await projection.ensureMaterialized();
  }
  const searchIdentities = values["search-workload"]
    ? await lists.prepareSessionSearchIdentityNames(projection, {}, true)
    : undefined;
  const rows = projection.selectEntries({ agentId: "main" });
  if (values["sort-rows"]) {
    writeFileSync(
      path.resolve(values["sort-rows"]),
      JSON.stringify(rows.filter((row) => row.entry).map((row) => [row.key, row.entry])),
    );
  }
  const children = rows.filter((row) => row.key.startsWith("agent:main:subagent:")).slice(0, 8);
  const collectorParent = fixture.summary.stressTargets?.[0]?.sessionKey;
  const parent = rows.find(
    (row) =>
      row.entry &&
      (values["collector-presentation"]
        ? row.key === collectorParent
        : row.key.startsWith("agent:main:dashboard:")),
  );
  assert(parent && children.length > 0, "Team fixture must contain child and dashboard rows");
  const requesterParents = values["running-candidates"]
    ? rows.filter(
        (row) =>
          row.key.startsWith("agent:main:dashboard:") &&
          row.entry &&
          row.entry.archivedAt === undefined,
      )
    : [parent];
  assert(requesterParents.length > 0, "Running candidates require unarchived parent rows");
  for (const [index, child] of children.entries()) {
    assert(child.entry);
    const requesterParent = requesterParents[index % requesterParents.length]!;
    active.push({
      runId: `prepared-list-live-${index}`,
      childSessionKey: child.key,
      childAgentId: "main",
      childSessionIdentity: { sessionId: child.entry.sessionId },
      requesterSessionKey: requesterParent.key,
      requesterAgentId: "main",
      requesterDisplayKey: requesterParent.key,
      controllerSessionKey: requesterParent.key,
      task: "Synthetic list preparation churn",
      cleanup: "keep",
      generation: 1,
      createdAt: clock,
      execution: {
        status: "terminal",
        startedAt: clock,
        endedAt: clock,
        outcome: { status: "ok" },
      },
      delivery: { status: "not_required" },
    });
  }
  const unrelated = rows.find((row) => row.entry?.archivedAt !== undefined);
  assert(unrelated?.entry, "Team fixture must contain archived rows");
  const metadataTargets = rows
    .filter((row) => row.entry && row.entry.archivedAt === undefined)
    .slice(0, 64);
  let updates = 0;
  const update = () => {
    const index = updates % active.length;
    const previous = active[index]!;
    const claim = claims.get(previous.runId);
    if (claim) {
      registry.releaseAgentRunContext(previous.runId, claim);
      claims.delete(previous.runId);
    }
    const running = Math.floor(updates / active.length) % 2 === 0;
    const next: SubagentRunRecord = {
      ...previous,
      execution: running
        ? { status: "running", startedAt: clock }
        : { status: "terminal", startedAt: clock - 500, endedAt: clock, outcome: { status: "ok" } },
      cleanupCompletedAt: running ? undefined : clock,
    };
    memory.subagentRuns.set(next.runId, next);
    if (running) {
      const token = registry.claimAgentRunContext(
        next.runId,
        {
          agentId: "main",
          sessionKey: next.childSessionKey,
          sessionId: next.childSessionIdentity?.sessionId,
          lifecycleStartedAt: clock,
          projectSessionActive: true,
          isControlUiVisible: true,
        },
        { trackOwner: true, ownsContext: true },
      );
      assert(token);
      claims.set(next.runId, token);
    }
    active[index] = next;
    publications.publishSubagentRunChanges([next.childSessionKey], [next.runId]);
    updates++;
  };
  const read = (index: number) =>
    lists.listProjectedSessions({
      projection: projection!,
      opts: cases[index % cases.length]!,
      client: viewer,
      acceptsSerializedJson: true,
    });
  const capture = async () => {
    const digest = createHash("sha256");
    for (let index = 0; index < cases.length; index++) {
      digest.update(canonicalResult(await read(index)));
    }
    return digest.digest("hex");
  };
  const { withPreparedEventRow } = await import("../../src/gateway/session-event-prepared-row.js");
  const { prepareProjectedSessionPresentation } =
    await import("../../src/gateway/session-row-presentation.js");
  const { getSessionRowSelectionMetrics } = await import("../../src/infra/gateway-work-metrics.js");
  const exactCalls = () =>
    getSessionRowSelectionMetrics().selections.reduce(
      (total, value) => total + (value.kind === "exact" ? value.calls : 0),
      0,
    );
  const firstReadStarted = performance.now();
  const initialGolden = await capture();
  const firstReadMs = performance.now() - firstReadStarted;
  let sequence = 0;
  const durations: number[] = [];
  let listCpuMicros = 0;
  let updateCpuMicros = 0;
  let returnedRows = 0;
  let presentationCpuMicros = 0;
  let presentationSelections = 0;
  let collectorChildren = 0;
  const eventResponses =
    values.mode === "verify" && values["collector-presentation"] ? createHash("sha256") : undefined;
  const bySearch = new Map<
    string,
    {
      calls: number;
      cpuMicros: number;
      maxCpuMicros: number;
      filterCpuMicros: number;
      maxFilterCpuMicros: number;
    }
  >();
  const responses = values.mode === "verify" ? createHash("sha256") : undefined;
  const run = async (count: number, measured: boolean) => {
    for (let index = 0; index < count; index++) {
      clock += 1_000;
      let before = process.threadCpuUsage();
      for (let step = 0; step < updatesPerList; step++) {
        update();
      }
      if (values["metadata-churn"]) {
        const target = metadataTargets[sequence % metadataTargets.length]!;
        const scope = {
          agentId: target.agentId,
          storePath: target.storeTarget.storePath,
          sessionKey: target.key,
        };
        const entry = sessionEntries.loadSessionEntry(scope);
        assert(entry);
        const kind = sequence % 10;
        sessionEntries.replaceSessionEntrySync(scope, {
          ...entry,
          ...(kind < 7
            ? { updatedAt: clock }
            : kind === 7
              ? { activeWriterRunId: `synthetic-writer-${sequence}` }
              : kind === 8
                ? { inputTokens: sequence }
                : { abortedLastRun: !entry.abortedLastRun }),
        });
        if (sequence % 3 === 0) {
          changes.sessionChanges.emit({
            ...scope,
            scope: "transcript",
            facts: { kind: "unchanged" },
          });
        }
      }
      if (values.reconciliation) {
        // Exercise the existing incomplete-postimage reconciliation contract explicitly.
        sessionEntries.replaceSessionEntrySync(
          { agentId: "main", sessionKey: unrelated.key },
          { ...unrelated.entry!, label: `Synthetic reconciliation ${sequence % 2}` },
        );
        changes.sessionChanges.emit({
          agentId: "main",
          storePath: unrelated.storeTarget.storePath,
          sessionKey: unrelated.key,
          factsInvalidated: true,
        });
      }
      let used = process.threadCpuUsage(before);
      if (measured) {
        updateCpuMicros += used.user + used.system;
      }
      if (values["collector-presentation"]) {
        await withPreparedEventRow(projection, { agentId: "main", key: parent.key }, (prepared) => {
          assert(prepared);
          const calls = exactCalls();
          const presentationBefore = process.threadCpuUsage();
          const row = prepareProjectedSessionPresentation(prepared, viewer, clock).snapshot({
            agentId: "main",
            key: parent.key,
          }).row;
          const presentationUsed = process.threadCpuUsage(presentationBefore);
          assert(
            row?.swarm?.groups[0]?.children?.length,
            "Collector fixture must expose child detail",
          );
          eventResponses?.update(canonicalResult(row));
          if (measured) {
            presentationCpuMicros += presentationUsed.user + presentationUsed.system;
            presentationSelections += exactCalls() - calls;
            collectorChildren += row.swarm.groups[0].children.length;
          }
        });
      }
      before = process.threadCpuUsage();
      const callStarted = performance.now();
      const query = cases[sequence % cases.length]!;
      const result = await read(sequence++);
      used = process.threadCpuUsage(before);
      if (
        values.mode === "verify" &&
        values["running-candidates"] &&
        (sequence - 1) % cases.length === 0
      ) {
        assert(result.ownerSessionCounts);
        assert.equal(
          result.ownerSessionCounts.reduce((total, owner) => total + owner.running, 0),
          new Set(
            active
              .filter((subagentRun) => subagentRun.execution?.status === "running")
              .map((subagentRun) => subagentRun.requesterSessionKey),
          ).size,
        );
      }
      assert.equal(result.count, result.sessions.length);
      assert(typeof result.totalCount === "number");
      assert(result.totalCount >= result.count);
      responses?.update(canonicalResult(result));
      if (measured) {
        durations.push(performance.now() - callStarted);
        listCpuMicros += used.user + used.system;
        returnedRows += result.count;
        if (values["search-workload"]) {
          const sample = bySearch.get(query.search!) ?? {
            calls: 0,
            cpuMicros: 0,
            maxCpuMicros: 0,
            filterCpuMicros: 0,
            maxFilterCpuMicros: 0,
          };
          sample.calls++;
          sample.cpuMicros += used.user + used.system;
          sample.maxCpuMicros = Math.max(sample.maxCpuMicros, used.user + used.system);
          bySearch.set(query.search!, sample);
        }
      }
    }
  };
  await run(warmup, false);
  global.gc();
  await nextTurn();
  inspector.connect();
  connected = true;
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else if (values["cpu-profile"]) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.setSamplingInterval", { interval: 100 });
    await inspector.post("Profiler.start");
  }
  const started = performance.now();
  const beforeSelections = workMetrics.getSessionRowSelectionMetrics();
  const before = process.threadCpuUsage();
  await run(iterations, true);
  const used = process.threadCpuUsage(before);
  const elapsedMs = performance.now() - started;
  const afterSelections = workMetrics.getSessionRowSelectionMetrics();
  const allocation =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  const cpu = values["cpu-profile"] ? (await inspector.post("Profiler.stop")).profile : undefined;
  // Owner probes allocate full result arrays; keep them out of subsequent list samples.
  if (values["search-workload"]) {
    for (let index = sequence - iterations; index < sequence; index++) {
      const query = cases[index % cases.length]!;
      const sample = bySearch.get(query.search!)!;
      const prepared = lists.prepareSessionRowSelection(projection, query, {
        now: clock,
        metadataPrepared: true,
      });
      const filterBefore = process.threadCpuUsage();
      filterSessionEntries({ ...prepared, identityNames: searchIdentities?.names });
      const filterUsed = process.threadCpuUsage(filterBefore);
      sample.filterCpuMicros += filterUsed.user + filterUsed.system;
      sample.maxFilterCpuMicros = Math.max(
        sample.maxFilterCpuMicros,
        filterUsed.user + filterUsed.system,
      );
    }
  }
  if (allocation) {
    writeFileSync(path.join(root, "allocation.heapprofile"), JSON.stringify(allocation));
  }
  if (cpu) {
    writeFileSync(path.join(root, "cpu.cpuprofile"), JSON.stringify(cpu));
  }
  const golden = {
    initial: initialGolden,
    final: await capture(),
    ...(responses ? { responses: responses.digest("hex") } : {}),
    ...(eventResponses ? { collectorRows: eventResponses.digest("hex") } : {}),
  };
  if (values.golden) {
    assert.deepEqual(golden, JSON.parse(readFileSync(values.golden, "utf8")));
  }
  writeFileSync(path.join(root, "golden.json"), JSON.stringify(golden, null, 2));
  const bytes = allocation ? sampledBytes(allocation) : undefined;
  const leafBytes = new Map<string, number>();
  const rankLeaves = (node: HeapProfiler.SamplingHeapProfileNode) => {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    const frame = `${functionName || "(anonymous)"} ${url}:${lineNumber + 1}:${columnNumber + 1}`;
    leafBytes.set(frame, (leafBytes.get(frame) ?? 0) + node.selfSize);
    for (const child of node.children) {
      rankLeaves(child);
    }
  };
  if (allocation) {
    rankLeaves(allocation.head);
  }
  const partitionTotals = (metrics: typeof beforeSelections) =>
    metrics.partitions.reduce(
      (total, part) => ({ hits: total.hits + part.hits, misses: total.misses + part.misses }),
      { hits: 0, misses: 0 },
    );
  const firstPartitions = partitionTotals(beforeSelections);
  const lastPartitions = partitionTotals(afterSelections);
  const candidateSelections = (snapshot: typeof beforeSelections) =>
    snapshot.selections.reduce(
      (total, metric) => total + (metric.kind === "running-candidate" ? metric.calls : 0),
      0,
    );
  const runningCandidateSelections =
    candidateSelections(afterSelections) - candidateSelections(beforeSelections);
  const sampled = cpu ? sampledCpu(cpu) : undefined;
  durations.sort((a, b) => a - b);
  const result = {
    mode: values.mode,
    presentationSourceHash,
    filterSourceHash,
    listShape: values["list-shape"],
    allocationLeaves: Array.from(leafBytes)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 30),
    runningCandidateWorkload: values["running-candidates"],
    cpuProfile: values["cpu-profile"],
    reconciliation: values.reconciliation,
    metadataChurn: values["metadata-churn"],
    partitions: {
      hits: lastPartitions.hits - firstPartitions.hits,
      misses: lastPartitions.misses - firstPartitions.misses,
    },
    sortWorkload: values["sort-workload"],
    collectorPresentation: values["collector-presentation"],
    presentationCpuMsPerCall: presentationCpuMicros / 1000 / iterations,
    presentationSelectionsPerCall: presentationSelections / iterations,
    collectorChildrenPerCall: collectorChildren / iterations,
    sessions,
    acpRows: values["acp-rows"],
    sourceRef: values["source-ref"] ?? "working-tree",
    firstReadMs,
    latencyMs: {
      median: durations[Math.floor(durations.length * 0.5)],
      p95: durations[Math.floor(durations.length * 0.95)],
      max: durations.at(-1),
    },
    agents: Object.keys(cfg.agents?.entries ?? {}).length,
    iterations,
    warmup,
    updatesPerList,
    runningCandidateSelections,
    runningCandidateSelectionsPerList: runningCandidateSelections / iterations,
    returnedRows,
    elapsedMs,
    threadCpuMs: (used.user + used.system) / 1000,
    listCpuMsPerCall: listCpuMicros / 1000 / iterations,
    updateCpuMsPerCall: updateCpuMicros / 1000 / iterations,
    allocatedBytes: bytes,
    allocatedBytesPerList:
      bytes &&
      Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, value / iterations])),
    targetSelfCpuMicros: sampled?.selfMicros,
    targetInclusiveCpuMicros: sampled?.inclusiveMicros,
    bySearch: Object.fromEntries(bySearch),
    golden,
    cases,
    host: { node: process.version, load: loadavg() },
    scope:
      "Owner-level lists with registry churn; sort-workload uses an identified synthetic operator, limit 200, owner-first, involvement, and recency queries. No transport/model claim. Reconciliation is an explicit incomplete-postimage scenario. Heap family samples overlap and exclude native backing stores.",
  };
  writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  Date.now = realNow;
  if (connected) {
    inspector.disconnect();
  }
  projection?.dispose();
  releaseForeground();
  for (const [runId, claim] of claims) {
    registry.releaseAgentRunContext(runId, claim);
  }
  for (const entry of active) {
    memory.subagentRuns.delete(entry.runId);
  }
  config.clearRuntimeConfigSnapshot();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
