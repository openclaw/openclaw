/// <reference lib="es2024.object" />
/**
 * Real resident session-selection/search owner workload; no Gateway transport claim.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-list-search-measure.ts \
 *   --state-dir "$PWD/.local/search-base-1" --sessions 2000 --iterations 350 --mode timing
 * Repeat in a fresh directory with --mode allocation. Use --iterations 3 --warmup 1
 * for setup smoke. Iterations are PER QUERY (seven queries, including no search).
 * --reuse-fixture reopens a successfully completed fixture without reseeding or augmentation;
 * runs sharing a directory must be serial. --base-filter <adjacent baseline .ts copy>
 * compares both filter owners in one process, with --pairs 5 alternating AB/BA.
 * Compare identical scripts on pinned revisions in alternating AB/BA launch order.
 * Acceptance: identical response digests and fewer target reads, lower CPU or allocation
 * without a reproducible adverse sibling-query result. Record host load for each arm.
 * The canonical Team fixture supplies owners, ancestry, archived rows and real worktrees;
 * this script adds long/group titles and model overrides before projection admission.
 * Unlike row-only test fixtures, cold archived rows reconstruct actual model/thinking
 * facts. Timing is untraced; allocation sampling separately includes collected objects.
 * --selection-workload measures no-search roster, exclusion, archive and relationship
 * queries for three viewers through prepareProjectedSessionList's real sharing filter.
 * Use --iterations 2000 --pairs 5; compare filter calls and owner projections as well
 * as CPU/allocation. --base-list and --candidate-list compare the preparation owner
 * instead of the filter owner; serialized responses are compared after timing, excluding
 * the per-array random rowsRevision token. Facets and selected entry bytes must match for every query/viewer.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../src/agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeStressFixture } from "./team-shape-stress-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "2000" },
    iterations: { type: "string", default: "350" },
    warmup: { type: "string", default: "4" },
    mode: { type: "string", default: "timing" },
    golden: { type: "string" },
    "reuse-fixture": { type: "boolean", default: false },
    "base-filter": { type: "string" },
    "candidate-filter": { type: "string" },
    "base-list": { type: "string" },
    "candidate-list": { type: "string" },
    pairs: { type: "string", default: "5" },
    "selection-workload": { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "--state-dir must name a new synthetic directory");
assert(values.mode === "timing" || values.mode === "allocation");
assert(
  !values["candidate-filter"] || values["base-filter"],
  "--candidate-filter requires --base-filter",
);
assert(!values["candidate-list"] || values["base-list"], "--candidate-list requires --base-list");
assert(
  !values["base-list"] || values["selection-workload"],
  "--base-list requires --selection-workload",
);
assert(global.gc, "Run with --expose-gc");
const integer = (name: "sessions" | "iterations" | "warmup" | "pairs", min = 1) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const sessions = integer("sessions", 100);
const iterations = integer("iterations");
const warmup = integer("warmup");
const pairs = values["base-filter"] || values["base-list"] ? integer("pairs") : 1;
assert(iterations >= pairs && iterations % pairs === 0, "iterations must divide into pairs");
const root = path.resolve(values["state-dir"]);
const anchor = Date.UTC(2026, 9, 25);
const sourceSha256 = createHash("sha256")
  .update(
    readFileSync(
      values["candidate-list"] ??
        values["candidate-filter"] ??
        new URL(
          values["base-list"]
            ? "../../src/gateway/session-utils-list.ts"
            : "../../src/gateway/session-list-filters.ts",
          import.meta.url,
        ),
    ),
  )
  .digest("hex");
if (values["reuse-fixture"]) {
  const previous = JSON.parse(readFileSync(path.join(root, "result.json"), "utf8"));
  assert.equal(previous.sessions, sessions, "reuse requires the same fixture size");
  assert(
    previous.shape?.rows >= sessions && previous.golden,
    "reuse requires a completed search fixture",
  );
}
const fixture = values["reuse-fixture"]
  ? {
      env: {
        ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
          startupTrace: false,
        }),
        OPENCLAW_STATE_DIR: root,
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        USERPROFILE: path.join(root, "home"),
        OPENCLAW_PROFILE: "team-shape-40985",
        OPENCLAW_SKIP_CHANNELS: "1",
      },
    }
  : await generateTeamShapeStressFixture({
      stateDir: root,
      port: 40985,
      seed: 224,
      now: anchor,
      sessions,
      transcriptMiB: 0,
    });
process.env = { ...fixture.env };
const cfg: OpenClawConfig = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
assert(cfg.agents?.entries?.main);
if (!values["reuse-fixture"]) {
  cfg.agents.entries.main.identity = { name: "Synthetic Explorer" };
  cfg.agents.entries.main.model = "openai/gpt-4.1";
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
}
const [
  config,
  agentDb,
  stateDb,
  entryStore,
  memory,
  persistence,
  projections,
  lists,
  roster,
  foreground,
  plugins,
  pluginRegistry,
  registry,
  publications,
  activeRuns,
  presentations,
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/agents/subagents/registry/subagent-registry-memory.js"),
  import("../../src/agents/subagents/registry/subagent-registry-persistence.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-utils-list.js"),
  import("../../src/agents/agent-scope-config.js"),
  import("../../src/gateway/session-projection-work.js"),
  import("../../src/plugins/runtime.js"),
  import("../../src/plugins/registry-empty.js"),
  import("../../src/infra/agent-run-registry.js"),
  import("../../src/agents/subagents/registry/subagent-registry-publication.js"),
  import("../../src/gateway/server-methods/session-active-runs.js"),
  import("../../src/gateway/session-row-presentation.js"),
]);
config.setRuntimeConfigSnapshot(cfg);
plugins.setActivePluginRegistry(pluginRegistry.createEmptyPluginRegistry());
const releaseForeground = foreground.retainSessionListForegroundWork();
const realNow = Date.now;
Date.now = () => anchor;
let projection: Awaited<ReturnType<typeof projections.createSessionRowProjection>> | undefined;
const inspector = new Session();
let connected = false;
const claims = new Map<string, string>();

const catalog: ModelCatalogEntry[] = [
  { provider: "openai", id: "gpt-4.1", name: "GPT-4.1", contextWindow: 128000, input: ["text"] },
  {
    provider: "anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    contextWindow: 200000,
    input: ["text"],
    reasoning: true,
  },
];
// Synthetic vocabulary classes from #185426, not captured user search strings.
const queries = [
  undefined,
  "investigation 123",
  "Explorer",
  "gpt-4.1",
  "running",
  "idle",
  "zz-no-match",
];
const profileId = "team-shape-profile-0";
const selectionQueries: Array<{ name: string; opts: SessionsListParams }> = [
  { name: "roster", opts: {} },
  { name: "roots", opts: { excludeSubagents: true, excludeCron: true, excludeSystem: true } },
  { name: "archived", opts: { archived: true, excludeSubagents: true } },
  { name: "recent", opts: { activeMinutes: 7 * 24 * 60 } },
  { name: "personal", opts: { involvingMe: true } },
  { name: "created", opts: { profileRelation: { relationship: "created", profileId } } },
  { name: "related", opts: { profileRelation: { relationship: "involving", profileId } } },
];
const viewers: GatewayClient[] = [0, 1, 2].map((index) => {
  const id = `team-shape-profile-${index}`;
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "bench", platform: "bench", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write", ...(index === 2 ? ["operator.admin"] : [])],
    },
    authenticatedUserProfile: {
      profileId: id,
      displayName: null,
      hasAvatar: false,
      updatedAt: anchor,
    },
    preparedSessionProfile: { profileId: id, aliases: new Set([id]), role: null },
  };
});
const digest = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "string" ? item.replaceAll(root, "<synthetic-state>") : item,
      ),
    )
    .digest("hex");
const allocationBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + allocationBytes(child), 0);

try {
  // Offline fixture augmentation precedes any resident projection or timed work.
  if (!values["reuse-fixture"]) {
    const database = agentDb.openOpenClawAgentDatabase({ agentId: "main" });
    const entries = Object.entries(entryStore.readSessionEntryStore(database));
    for (let offset = 0; offset < entries.length; offset += 100) {
      agentDb.runOpenClawAgentWriteTransaction(
        (owner) => {
          for (const [index, [key, previous]] of entries.slice(offset, offset + 100).entries()) {
            const ordinal = offset + index;
            const model = catalog[ordinal % 5 === 0 ? 1 : 0]!;
            entryStore.writeSessionEntry(owner, key, {
              ...previous,
              label: `${previous.label}: trace ownership, reconcile worker observations, and verify the session selection boundary for project ${ordinal % 4}`,
              displayName: `${previous.displayName} — Review multi-stage worktree investigation and follow-up results ${"with reproducible evidence and shared context; ".repeat(3)}`,
              category: `worktree-project-${ordinal % 4}`,
              ...(key.includes(":discord:")
                ? {
                    subject: `Synthetic engineering discussion ${ordinal}`,
                    groupChannel: `project-${ordinal % 4}`,
                    space: "synthetic-team",
                  }
                : {}),
              providerOverride: model.provider,
              modelOverride: model.id,
            });
          }
        },
        { agentId: "main" },
      );
      await nextTurn();
    }
  }
  await persistence.restoreSubagentRunsFromDisk({ runs: memory.subagentRuns });
  // Keep a bounded live cohort alongside the retained ancestry, without starting turns.
  const liveRuns = [...memory.subagentRuns.values()].slice(0, 12);
  for (const [index, run] of liveRuns.entries()) {
    memory.subagentRuns.set(run.runId, {
      ...run,
      model: index % 2 ? "openai/gpt-4.1" : "anthropic/claude-sonnet-4",
      execution: { status: "running", startedAt: anchor - 30_000 },
      cleanupCompletedAt: undefined,
    });
    assert(run.childAgentId && run.childSessionIdentity?.sessionId);
    const claim = registry.claimAgentRunContext(
      run.runId,
      {
        agentId: run.childAgentId,
        sessionKey: run.childSessionKey,
        sessionId: run.childSessionIdentity.sessionId,
        lifecycleStartedAt: anchor - 30_000,
        projectSessionActive: true,
        isControlUiVisible: true,
      },
      { trackOwner: true, ownsContext: true },
    );
    assert(claim);
    claims.set(run.runId, claim);
  }
  publications.publishSubagentRunChanges(
    liveRuns.map((run) => run.childSessionKey),
    liveRuns.map((run) => run.runId),
  );
  projection = await projections.createSessionRowProjection({ cfg, modelCatalog: catalog });
  await projection.ensureMaterialized();
  await projection.prepareSelection({ metadataOnly: false, includeCatalog: true });
  const identities = await lists.prepareSessionSearchIdentityNames(projection, {}, true);
  const shapeRows = projection.selectEntries({ sortBy: null });
  const shape = {
    rows: shapeRows.length,
    archived: shapeRows.filter((row) => row.entry?.archivedAt !== undefined).length,
    parented: shapeRows.filter((row) => row.entry?.parentSessionKey).length,
    worktrees: shapeRows.filter((row) => row.entry?.worktree).length,
    groups: shapeRows.filter((row) => row.key.includes(":discord:")).length,
    retainedRuns: memory.subagentRuns.size,
    liveRuns: liveRuns.length,
    materialized: projection.materializedCount,
  };
  assert(shape.rows >= sessions && shape.parented > 100 && shape.archived > 100);
  assert(shape.worktrees > 100 && shape.retainedRuns > 100 && shape.groups > 0);
  const results = [];
  const golden: Record<string, string> = {};
  const responseRequests = new Map<string, Parameters<typeof lists.listProjectedSessions>[0]>();
  const currentFilters: typeof import("../../src/gateway/session-list-filters.js") = await import(
    values["candidate-filter"]
      ? pathToFileURL(path.resolve(values["candidate-filter"])).href
      : "../../src/gateway/session-list-filters.js"
  );
  const baseFilters: typeof currentFilters | undefined = values["base-filter"]
    ? await import(pathToFileURL(path.resolve(values["base-filter"])).href)
    : undefined;
  const candidateLists: typeof lists = values["candidate-list"]
    ? await import(pathToFileURL(path.resolve(values["candidate-list"])).href)
    : lists;
  const baseLists: typeof lists | undefined = values["base-list"]
    ? await import(pathToFileURL(path.resolve(values["base-list"])).href)
    : undefined;
  inspector.connect();
  connected = true;
  const workloads = values["selection-workload"]
    ? selectionQueries.flatMap(({ name, opts }) =>
        viewers.map((client, index) => ({
          name: `${name}:viewer-${index}`,
          opts,
          client,
        })),
      )
    : queries.map((search) => ({
        name: search ?? "<no-search>",
        opts: { search },
        client: undefined,
      }));
  for (const workload of workloads) {
    const { name, client } = workload;
    const search = workload.opts.search;
    const opts: SessionsListParams = {
      source: search === undefined ? "agent-roster" : "sessions-page",
      rowMode: search === undefined ? "sidebar" : "compact",
      archived: "all",
      limit: 50,
      excludeDock: true,
      ...workload.opts,
    };
    if (baseLists) {
      responseRequests.set(name, { projection, opts, client });
    }
    const prepare = (listOwner = lists) => {
      const current = projection!;
      if (values["selection-workload"]) {
        return listOwner.prepareProjectedSessionList({
          projection: current,
          opts,
          client,
          now: anchor,
          metadataPrepared: true,
        }).filters;
      }
      const projectRun = activeRuns.createVisibleActiveSessionRunProjector(
        current.state.rowContext.projectedAgentRuns,
        undefined,
        undefined,
        current.physicalPaths,
      );
      const presentation = presentations
        .prepareSessionRowPublication(current, anchor)(undefined, projectRun)
        .getPresentation();
      const prepared = lists.prepareSessionRowSelection(current, opts, {
        now: anchor,
        rowContext: presentation.rowContext,
        metadataPrepared: true,
        ordered: true,
      });
      return {
        ...prepared,
        identityNames: identities.names,
        entriesSorted: true,
        projectActiveRun: (key: string) => presentation.active(prepared.getTarget(key)!)!,
      };
    };
    const window = { offset: 0, limit: 50, ownerLimit: 0 };
    const arms =
      baseFilters || baseLists
        ? [
            {
              name: "base",
              prepare: () => prepare(baseLists ?? lists),
              select: (params: ReturnType<typeof prepare>) =>
                (baseFilters ?? currentFilters).filterSessionEntries(params, window),
            },
            {
              name: "candidate",
              prepare: () => prepare(candidateLists),
              select: (params: ReturnType<typeof prepare>) =>
                currentFilters.filterSessionEntries(params, window),
            },
          ]
        : [{ name: "selection", prepare, select: lists.selectSessionEntries }];
    for (const arm of arms) {
      const expected = roster.withAgentRosterFactsBatch(cfg, () => arm.select(arm.prepare()));
      if (search === "running" || search === "idle") {
        assert(expected.totalCount > 0, `${search} must exercise its real active-run branch`);
        assert(expected.totalCount < sessions, `${search} must distinguish the mixed run states`);
      }
      if (golden[name]) {
        assert.equal(digest(expected), golden[name], "base/candidate result equality");
      }
      golden[name] = digest(expected);
      for (let index = 0; index < warmup; index++) {
        roster.withAgentRosterFactsBatch(cfg, () => arm.select(arm.prepare()));
      }
    }
    const count = iterations / pairs;
    for (let pair = 0; pair < pairs; pair++) {
      for (const arm of pair % 2 ? arms.toReversed() : arms) {
        const read = () => roster.withAgentRosterFactsBatch(cfg, () => arm.select(arm.prepare()));
        let targetReads = 0;
        let modelFactsReads = 0;
        let sharingChecks = 0;
        let ownerProjections = 0;
        const counted = arm.prepare();
        const originalTarget = counted.getTarget;
        const originalModelFacts = counted.getModelFacts;
        const originalFilter = counted.entryFilter;
        if (originalFilter) {
          counted.entryFilter = (...args) => {
            sharingChecks++;
            return originalFilter(...args);
          };
        }
        const identityProjection = counted.getRowContext().identityProjection;
        const originalOwner = identityProjection?.owner;
        if (identityProjection && originalOwner) {
          identityProjection.owner = (...args) => {
            ownerProjections++;
            return originalOwner(...args);
          };
        }
        counted.getTarget = (key) => {
          targetReads++;
          return originalTarget(key);
        };
        counted.getModelFacts = (key) => {
          modelFactsReads++;
          assert(originalModelFacts);
          return originalModelFacts(key);
        };
        const expected = roster.withAgentRosterFactsBatch(cfg, () => arm.select(counted));
        if (identityProjection && originalOwner) {
          identityProjection.owner = originalOwner;
        }
        global.gc();
        await nextTurn();
        const collections: PerformanceEntry[] = [];
        const observer = new PerformanceObserver((list) => collections.push(...list.getEntries()));
        observer.observe({ entryTypes: ["gc"] });
        if (values.mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const hostLoad = loadavg();
        const before = process.threadCpuUsage();
        const start = performance.now();
        let returned = 0;
        let last = expected;
        for (let index = 0; index < count; index++) {
          last = read();
          returned += last.entries.length;
        }
        const elapsedMs = performance.now() - start;
        const used = process.threadCpuUsage(before);
        const profile =
          values.mode === "allocation"
            ? (await inspector.post("HeapProfiler.stopSampling")).profile
            : undefined;
        await nextTurn();
        await nextTurn();
        collections.push(...observer.takeRecords());
        observer.disconnect();
        assert.equal(returned, expected.entries.length * count);
        assert.equal(digest(last), golden[name]);
        results.push({
          search: name,
          arm: arm.name,
          pair,
          iterations: count,
          matched: expected.totalCount,
          returned: expected.entries.length,
          filterTargetReads: targetReads,
          filterModelFactsReads: modelFactsReads,
          sharingChecks,
          ownerProjections,
          hostLoad,
          cpuMsPerCall: (used.user + used.system) / 1000 / count,
          wallMsPerCall: elapsedMs / count,
          allocatedBytesPerCall: profile ? allocationBytes(profile.head) / count : undefined,
          gcMsPerCall: collections.reduce((sum, entry) => sum + entry.duration, 0) / count,
          gcCount: collections.length,
          gcMaxMs: Math.max(0, ...collections.map((entry) => entry.duration)),
          memory: process.memoryUsage(),
        });
        console.error(
          JSON.stringify({
            completed: name,
            arm: arm.name,
            pair,
            mode: values.mode,
            iterations: count,
          }),
        );
      }
    }
  }
  const responseGolden: Record<string, string> = {};
  for (const [name, request] of responseRequests) {
    assert(baseLists);
    const baseline = await baseLists.listProjectedSessions(request);
    const candidate = await candidateLists.listProjectedSessions(request);
    // Each non-retained row array gets a fresh UUID, including identical-source calls.
    assert.equal(typeof candidate.rowsRevision, typeof baseline.rowsRevision);
    const responseDigest = digest({ ...candidate, rowsRevision: undefined });
    assert.equal(
      responseDigest,
      digest({ ...baseline, rowsRevision: undefined }),
      `response equality excluding random rowsRevision: ${name}`,
    );
    responseGolden[name] = responseDigest;
  }
  if (values.golden) {
    assert.deepEqual(golden, JSON.parse(readFileSync(values.golden, "utf8")));
  }
  writeFileSync(path.join(root, "golden.json"), JSON.stringify(golden, null, 2));
  const result = {
    node: process.version,
    sourceSha256,
    baseSourceSha256:
      values["base-list"] || values["base-filter"]
        ? createHash("sha256")
            .update(readFileSync((values["base-list"] ?? values["base-filter"])!))
            .digest("hex")
        : undefined,
    mode: values.mode,
    sessions,
    warmup,
    shape,
    results,
    aggregates: Object.fromEntries(
      Object.entries(Object.groupBy(results, (sample) => `${sample.arm}:${sample.search}`)).map(
        ([key, samples]) => {
          assert(samples);
          const mean = (pick: (sample: NonNullable<typeof samples>[number]) => number) =>
            samples.reduce((sum, sample) => sum + pick(sample), 0) / samples.length;
          return [
            key,
            {
              iterations: samples.reduce((sum, sample) => sum + sample.iterations, 0),
              cpuMsPerCall: mean((sample) => sample.cpuMsPerCall),
              wallMsPerCall: mean((sample) => sample.wallMsPerCall),
              allocatedBytesPerCall:
                values.mode === "allocation"
                  ? mean((sample) => sample.allocatedBytesPerCall!)
                  : undefined,
              gcMsPerCall: mean((sample) => sample.gcMsPerCall),
            },
          ];
        },
      ),
    ),
    golden,
    responseGolden,
    scope:
      "Real resident selection/filter/model-facts owners; no WebSocket or model turn load. Allocation-pass timing is diagnostic only.",
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
  memory.subagentRuns.clear();
  config.clearRuntimeConfigSnapshot();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
