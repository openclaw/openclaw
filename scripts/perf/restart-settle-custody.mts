/**
 * Indexed restart-wait owner, 10,800 synthetic sessions and 4,300 retained children.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/restart-settle-custody.mts \
 *   --output /absolute/new-result.json [--source /saved/subagent-registry-read.ts] [--control]
 * Interleave five baseline/candidate processes and five A/A control pairs.
 * --allocation samples a separate run; setup/imports/GC are outside owner timing.
 * --fixture loads session metadata from a generated Team fixture before owner timing.
 * This isolates the registry owner; it does not time database hydration or workspace I/O.
 * --discovery measures startup selection from that database, including unmarked requesters.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    source: { type: "string" },
    fixture: { type: "string" },
    control: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
    discovery: { type: "boolean", default: false },
  },
});
assert(values.output && global.gc, "Pass --output and launch with --expose-gc");
assert(path.isAbsolute(values.output), "Output must be an absolute path");
const stateDir = values.fixture ?? `${values.output}.state`;
if (!values.fixture) {
  mkdirSync(stateDir);
  writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
}
process.env.OPENCLAW_HOME = stateDir;
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
const ownerUrl = new URL(
  values.discovery
    ? "../../src/gateway/session-restart-resume-discovery.ts"
    : "../../src/agents/subagents/registry/subagent-registry-read.ts",
  import.meta.url,
).href;
let sourceLoaded = false;
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === ownerUrl && values.source) {
      sourceLoaded = true;
      return {
        format: "module-typescript",
        source: readFileSync(values.source, "utf8"),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const { resolveSessionYieldWait } =
  await import("../../src/agents/subagents/registry/subagent-registry-read.js");
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const { buildRequesterSettleWakeIdentity } =
  await import("../../src/agents/subagents/registry/subagent-requester-settle-identity.js");
const { prepareRestartStores } =
  await import("../../src/gateway/session-restart-resume-discovery.js");
const { resolveSessionStorePathCore } = await import("../../src/config/sessions/paths.js");
assert(!values.source || sourceLoaded, "Baseline source was not loaded");
assert.equal(subagentRuns.size, 0);
let sessions: Array<{ key: string; entry: InternalSessionEntry }> = Array.from(
  { length: 10_800 },
  (_, index) => ({
    key: `agent:main:dashboard:synthetic-${index}`,
    entry: {
      sessionId: `session-${index}`,
      lifecycleRevision: "synthetic",
      updatedAt: 1,
    },
  }),
);
if (values.fixture) {
  const { listSessionEntriesReadOnly } =
    await import("../../src/config/sessions/session-accessor.js");
  sessions = listSessionEntriesReadOnly({ agentId: "main" }, { deferParticipants: true }).map(
    ({ sessionKey, entry }) => ({ key: sessionKey, entry }),
  );
  assert(sessions.length >= 10_800, "Fixture must contain at least 10,800 sessions");
}
const parents = sessions.filter(({ entry }) => entry.archivedAt === undefined && !entry.incognito);
assert(parents.length >= 2_150);
for (let index = 0; index < 4_300; index++) {
  const parent = parents[Math.floor(index / 2)]!;
  const batchRunIds = [`child-${index - (index % 2)}`, `child-${index - (index % 2) + 1}`];
  const entry: SubagentRunRecord = {
    runId: `child-${index}`,
    childSessionKey: `agent:main:subagent:synthetic-${index}`,
    childAgentId: "main",
    requesterSessionKey: parent.key,
    requesterAgentId: "main",
    requesterDisplayKey: "synthetic",
    completionRequesterSessionId: parent.entry.sessionId,
    completionRequesterLifecycleRevision: parent.entry.lifecycleRevision,
    task: "synthetic retained result",
    cleanup: "keep",
    createdAt: 1,
    expectsCompletionMessage: true,
    execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
    completion: { required: true, resultText: "synthetic result", capturedAt: 2 },
    delivery: { status: "pending" },
    requesterSettleWake: {
      status: "dispatching",
      attemptCount: 1,
      batchRunIds,
      rearmGeneration: 1,
      requesterYieldBatch: true,
      requesterRunId: `parent-${Math.floor(index / 2)}`,
    },
  };
  subagentRuns.set(entry.runId, entry);
  if (values.discovery) {
    continue;
  }
  parent.entry.status = "killed";
  parent.entry.endedAt = 3;
  parent.entry.lastRunId = values.control
    ? `ordinary-${index}`
    : buildRequesterSettleWakeIdentity({
        requesterSessionKey: parent.key,
        requesterAgentId: "main",
        batchRunIds,
        rearmGeneration: 1,
      }).runId;
  parent.entry.lifecycleRunId = parent.entry.lastRunId;
}
async function classify() {
  if (values.discovery) {
    assert(values.fixture, "Discovery requires --fixture");
    const prepared = await prepareRestartStores(
      {
        context: {},
        signal: new AbortController().signal,
        log: {
          warn: (message) => {
            throw new Error(message);
          },
        },
      },
      [
        {
          agentId: "main",
          physicalAgentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
      ],
    );
    return prepared?.[0]?.entries.length ?? 0;
  }
  let waiting = 0;
  for (const session of sessions) {
    waiting += Number(resolveSessionYieldWait(session.key, session.entry, "main") === "waiting");
  }
  return waiting;
}
for (let warmup = 0; warmup < 20; warmup++) {
  await classify();
}
global.gc();
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const trials = [];
for (let trial = 0; trial < 20; trial++) {
  const cpu = process.cpuUsage();
  const start = performance.now();
  const waiting = await classify();
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  trials.push({ wallMs, cpuMs: (used.user + used.system) / 1000, waiting });
}
let sampledBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  writeFileSync(`${values.output}.heapprofile`, JSON.stringify(profile));
  inspector.disconnect();
}
writeFileSync(
  values.output,
  JSON.stringify({
    source: values.source ?? "candidate",
    fixture: values.fixture,
    control: values.control,
    discovery: values.discovery,
    sessions: sessions.length,
    children: subagentRuns.size,
    load: loadavg(),
    trials,
    sampledBytes,
  }) + "\n",
  { flag: "wx" },
);
subagentRuns.clear();
hook.deregister();
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { closeDefaultRetainedNativeWorkerSource } =
  await import("../../src/infra/worker-native-lifecycle.js");
await closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();
await closeDefaultRetainedNativeWorkerSource();
