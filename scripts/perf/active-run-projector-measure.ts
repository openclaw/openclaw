/**
 * Owner microbenchmark: registered active sessions, 65 interleaved callers, 50–2,000 rows.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/active-run-projector-measure.ts
 *   --state-dir .local/active-run-measure --workload page|event|publication --iterations 3000
 *   [--allocation] [--event-lookup scan|indexed] [--rows 50] [--runs 34] [--mixed]
 * Use separate timing/allocation passes, alternating base/candidate order.
 * --owner-dir <dir> loads saved session-active-runs.ts and session-controller.rpc-sources.ts
 * at their original module URLs, preserving the same dependency graph. Save both with
 * git show <base>:<source-path> before editing; use --event-lookup scan for the old
 * subscription lookup contract and indexed for the replacement owner operation.
 * "event" measures only scoped source lookup, not event dispatch or WebSocket latency.
 * "page" includes projector construction and every row (default: 34 active + 16 idle).
 * "publication" repeats filter/display active reads across three audience presenters;
 * use --rows 68 --runs 68 and --presentation-owner <saved source> for the baseline.
 * --audiences 1 --reads 1 measures the no-reuse presentation case.
 * --mixed adds terminal persistence, direct subagents and capacity waits. Output digests
 * cover indexed/direct projection, terminal history and foreign agent/store selections.
 * Preparation, work-count instrumentation, warmup, and cleanup are outside measurement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    workload: { type: "string", default: "page" },
    iterations: { type: "string", default: "3000" },
    mixed: { type: "boolean", default: false },
    rows: { type: "string", default: "50" },
    runs: { type: "string", default: "34" },
    allocation: { type: "boolean", default: false },
    "event-lookup": { type: "string", default: "indexed" },
    "owner-dir": { type: "string" },
    "state-dir": { type: "string" },
    "presentation-owner": { type: "string" },
    audiences: { type: "string", default: "3" },
    reads: { type: "string", default: "2" },
  },
});
assert(["page", "event", "publication"].includes(values.workload!));
assert(values["event-lookup"] === "scan" || values["event-lookup"] === "indexed");
assert(values["state-dir"], "Pass a new isolated --state-dir");
const stateDir = path.resolve(values["state-dir"]);
mkdirSync(stateDir, { mode: 0o700 });
const configPath = path.join(stateDir, "openclaw.json");
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = createGatewayBenchEnv(stateDir, configPath, { startupTrace: false });
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 3000,
});
const ownerPaths = [
  "../../src/gateway/server-methods/session-active-runs.ts",
  "../../src/sessions/session-controller.rpc-sources.ts",
];
const replacements = new Map(
  values["owner-dir"]
    ? ownerPaths.map((ownerPath) => [
        new URL(ownerPath, import.meta.url).href,
        pathToFileURL(path.resolve(values["owner-dir"]!, path.basename(ownerPath))).href,
      ])
    : [],
);
const loadedOwners = new Set<string>();
let presentationReplaced = false;
if (values["presentation-owner"]) {
  const owner = new URL("../../src/gateway/session-row-presentation.ts", import.meta.url).href;
  const source = readFileSync(values["presentation-owner"], "utf8");
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== owner) {
        return nextLoad(url, context);
      }
      presentationReplaced = true;
      return { format: "module-typescript", source, shortCircuit: true };
    },
  });
}
if (replacements.size) {
  registerHooks({
    load(url, context, nextLoad) {
      const replacement = replacements.get(url);
      if (!replacement) {
        return nextLoad(url, context);
      }
      loadedOwners.add(url);
      const result = nextLoad(replacement, context);
      return { format: result.format, source: result.source, shortCircuit: true };
    },
  });
}
const { createVisibleActiveSessionRunProjector, resolveVisibleActiveSessionRunState } =
  await import("../../src/gateway/server-methods/session-active-runs.js");
const { captureSessionTarget } = await import("../../src/sessions/session-controller.target.js");
const { reserveSessionControllerSource, retireSessionControllerInput } =
  await import("../../src/sessions/session-controller.mailbox.js");
const { registerRpcSource, listRpcSourceEntries, getRpcSourceForGateway } =
  await import("../../src/sessions/session-controller.rpc-sources.js");
const { rpcSourcesByRunId } = await import("../../src/sessions/session-controller.storage.js");
const { captureGatewayScopeMatcher } = await import("../../src/gateway/session-runtime-scope.js");
assert.equal(loadedOwners.size, replacements.size, "Requested baseline owners were not loaded");

const rows = parseStrictIntegerOption({ raw: values.rows, label: "--rows", min: 1, fallback: 50 });
const runs = parseStrictIntegerOption({ raw: values.runs, label: "--runs", min: 0, fallback: 34 });
const audiences = parseStrictIntegerOption({
  raw: values.audiences,
  label: "--audiences",
  min: 1,
  fallback: 3,
});
const reads = parseStrictIntegerOption({
  raw: values.reads,
  label: "--reads",
  min: 1,
  fallback: 2,
});
assert(runs <= rows);
assert(values.workload !== "event" || runs > 0);
const { claimAgentRunContext, releaseAgentRunContext, getAgentRunLifecycleGeneration } =
  await import("../../src/infra/agent-run-registry.js");
const { registerAgentRunCapacityWait } = await import("../../src/infra/agent-run-capacity-wait.js");
const { seedSubagentRunForReadTest } =
  await import("../../src/agents/subagents/registry/subagent-registry.test-helpers.js");
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const cleanups: (() => void)[] = [];
const clients = 65;
const storePath = "/synthetic/active-run-projector/sessions";
const selections = Array.from({ length: rows }, (_, index) => ({
  requestedKey: `agent:main:subagent:synthetic-${index}`,
  canonicalKey: `agent:main:subagent:synthetic-${index}`,
  sessionId: `synthetic-session-${index}`,
  storePath,
  agentId: "main",
  defaultAgentId: "main",
}));
const sources = selections.slice(0, runs).map((selection, index) => {
  const runId = `synthetic-run-${index}`;
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey: selection.canonicalKey,
    incarnation: selection.sessionId,
    agentId: "main",
  });
  const terminal = values.mixed && index % 4 === 0;
  const adapter = {
    kind: "agent" as const,
    controlUiVisible: true,
    projectSessionTerminalPending: terminal,
  };
  const input = reserveSessionControllerSource(target.sessionKey, {
    target,
    adapter,
    protocolRunId: runId,
    sourceSessionId: selection.sessionId,
    policy: { mode: "followup" },
  });
  const ref = { input, adapter };
  registerRpcSource(runId, ref);
  if (values.mixed && index % 4 === 1) {
    seedSubagentRunForReadTest({
      runId,
      childSessionKey: selection.canonicalKey,
      childAgentId: "main",
      requesterSessionKey: "agent:main:parent",
      requesterStorePath: storePath,
      controllerSessionKey: "agent:main:parent",
      controllerStorePath: storePath,
      task: "Synthetic projection benchmark",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 2,
    });
    const claim = claimAgentRunContext(
      runId,
      { sessionKey: selection.canonicalKey, agentId: "main" },
      { trackOwner: true, ownsContext: true },
    );
    assert(claim);
    cleanups.push(() => {
      releaseAgentRunContext(runId, claim);
      subagentRuns.delete(runId);
    });
    if (index % 8 === 1) {
      const release = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      cleanups.push(() => release?.());
    }
  }
  return { runId, ref };
});
const publicationFixture =
  values.workload === "publication"
    ? await (async () => {
        const { prepareSessionRowPublication } =
          await import("../../src/gateway/session-row-presentation.js");
        assert(
          !values["presentation-owner"] || presentationReplaced,
          "Presentation owner was not loaded",
        );
        const { createSessionRowProjectionFixture } =
          await import("../../src/gateway/session-row-projection.test-support.js");
        const { buildSessionListRowMetadataContext } =
          await import("../../src/gateway/session-utils-projection.js");
        const { buildSubagentRunReadIndexFromRuns } =
          await import("../../src/agents/subagents/registry/subagent-registry-queries.js");
        const projection = createSessionRowProjectionFixture({
          cfg: { agents: { entries: { main: {} } }, plugins: { enabled: false } },
          storePath,
          store: Object.fromEntries(
            selections.map((selection) => [
              selection.canonicalKey,
              { sessionId: selection.sessionId, updatedAt: 1 },
            ]),
          ),
          modelCatalog: [],
          rowContext: buildSessionListRowMetadataContext({
            now: 1_800_000_000_000,
            subagentRuns: buildSubagentRunReadIndexFromRuns({
              runs: new Map(),
              inMemoryRuns: [],
              now: 1_800_000_000_000,
            }),
          }),
        });
        return {
          prepare: prepareSessionRowPublication,
          projection,
          rows: projection.selectEntries({}),
        };
      })()
    : undefined;
const matchesGateway = captureGatewayScopeMatcher(undefined);
const lookup =
  values["event-lookup"] === "scan"
    ? (runId: string) => {
        const matches = listRpcSourceEntries().filter(
          ([candidateRunId, source]) => candidateRunId === runId && matchesGateway(source.input),
        );
        return matches.length === 1 ? matches[0]?.[1] : undefined;
      }
    : (runId: string) => getRpcSourceForGateway(runId, undefined);

const expectedActive = sources.filter(
  ({ ref }) => !ref.adapter.projectSessionTerminalPending,
).length;
const contractProjector = createVisibleActiveSessionRunProjector();
const contractDigest = createHash("sha256");
for (const selection of selections) {
  for (const selected of [
    selection,
    { ...selection, agentId: "foreign" },
    { ...selection, storePath: "/synthetic/foreign" },
  ]) {
    const direct = resolveVisibleActiveSessionRunState(selected);
    assert.deepEqual(contractProjector(selected), direct);
    contractDigest.update(
      JSON.stringify([
        direct,
        resolveVisibleActiveSessionRunState({ ...selected, includeTerminalPersistence: true }),
      ]),
    );
  }
}
const projectionDigest = contractDigest.digest("hex");
let activeProjectionCalls: number | undefined;
function runOne(index: number): number {
  const client = index % clients;
  if (values.workload === "event") {
    const source = sources[client % sources.length]!;
    assert.equal(lookup(source.runId), source.ref);
    return 1;
  }
  const liveProject = createVisibleActiveSessionRunProjector();
  const project =
    activeProjectionCalls === undefined
      ? liveProject
      : (selection: Parameters<typeof liveProject>[0]) => {
          activeProjectionCalls!++;
          return liveProject(selection);
        };
  if (publicationFixture) {
    const publication = publicationFixture.prepare(
      publicationFixture.projection,
      1_800_000_000_000,
    );
    let active = 0;
    for (let audience = 0; audience < audiences; audience++) {
      const presentation = publication(undefined, project).getPresentation();
      for (let pass = 0; pass < reads; pass++) {
        for (const row of publicationFixture.rows) {
          active += Number(presentation.active(row)?.active);
        }
      }
    }
    assert.equal(active, expectedActive * audiences * reads);
    return active;
  }
  let active = 0;
  for (let row = 0; row < selections.length; row++) {
    active += Number(project(selections[(row + client) % selections.length]!).active);
  }
  assert.equal(active, expectedActive);
  return active;
}
function run(count: number): number {
  let checksum = 0;
  for (let index = 0; index < count; index++) {
    checksum += runOne(index);
  }
  return checksum;
}
try {
  let registryScans = 0;
  let visitedRunIds = 0;
  const iterate = rpcSourcesByRunId[Symbol.iterator];
  rpcSourcesByRunId[Symbol.iterator] = function* () {
    registryScans++;
    for (const entry of iterate.call(this)) {
      visitedRunIds++;
      yield entry;
    }
    return undefined;
  };
  try {
    activeProjectionCalls = 0;
    runOne(0);
  } finally {
    rpcSourcesByRunId[Symbol.iterator] = iterate;
  }
  const activeProjectionsPerOperation = activeProjectionCalls;
  activeProjectionCalls = undefined;
  run(1000);
  globalThis.gc?.();
  const inspector = new Session();
  try {
    if (values.allocation) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoadBefore = loadavg();
    const memoryBefore = process.memoryUsage();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const checksum = run(iterations);
    const elapsedMs = performance.now() - started;
    const usedCpu = process.threadCpuUsage(cpu);
    const memoryAfter = process.memoryUsage();
    const allocatedBytes = values.allocation
      ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
    console.log(
      JSON.stringify({
        workload:
          values.workload === "publication"
            ? "publication-active-run-projection"
            : values.workload === "page"
              ? "page-active-run-projection"
              : "scoped-event-lookup",
        presentationOwner: values["presentation-owner"] ?? "current",
        mode: values.allocation ? "allocation" : "timing",
        ownerDir: values["owner-dir"] ?? "current",
        eventLookup: values["event-lookup"],
        node: process.version,
        registeredSources: sources.length,
        mixed: values.mixed,
        projectionDigest,
        clients,
        audiences: publicationFixture ? audiences : undefined,
        readsPerRowPerAudience: publicationFixture ? reads : undefined,
        rowsPerPage: selections.length,
        iterations,
        registryScansPerOperation: registryScans,
        visitedRunIdsPerOperation: visitedRunIds,
        activeProjectionsPerOperation,
        checksum,
        elapsedMs,
        cpuUsPerOperation: (usedCpu.user + usedCpu.system) / iterations,
        allocatedBytesPerOperation:
          allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        allocatedBytes,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
        memoryBefore,
        memoryAfter,
      }),
    );
  } finally {
    inspector.disconnect();
  }
} finally {
  for (const cleanup of cleanups.toReversed()) {
    cleanup();
  }
  for (const { ref } of sources) {
    retireSessionControllerInput(ref.input);
  }
  await Promise.all(sources.map(({ ref }) => ref.input.settlement.promise));
}
