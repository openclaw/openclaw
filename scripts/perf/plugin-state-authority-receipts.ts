/**
 * Real SQLite worker receipt census; synthetic state only, no Gateway or Team access.
 * node --import ./scripts/tsx.mjs scripts/perf/plugin-state-authority-receipts.ts \
 *   --output .local/authority/base-1 --rounds 10 [--allocations]
 * Repeat on candidate, counterbalancing AB/BA in separate processes. Sampling is a
 * separate pass; sampled CPU is not a timing verdict. Setup and readback are excluded.
 * --plugin-only isolates the keyed-store owner (same 44 stores and 10,000 idle sessions).
 *
 * Fixture: 10,000 mostly finished sessions, eight warm actors with 32-KiB skill
 * metadata, 44 synthetic plugin identities. Per round: one write per plugin,
 * eight adoptRun/completeTurn pairs, eight entry patches. Value strata are 24 x
 * 1 KiB, 12 x 4 KiB, 6 x 16 KiB and 2 x 64 KiB JSON body-size strata (plus JSON
 * and revision overhead). Small metadata,
 * checkpoints and retained delivery snapshots motivate this range; this is an
 * explicit sensitivity workload, NOT a measured Team size/frequency distribution.
 * One round represents one synthetic minute, so MB/min is bytes/round/1e6,
 * independently of execution speed. Metrics are actual from_worker authority
 * counters, including all request classes and unmeasured messages, not estimates
 * from serialized host publication facts. Acceptance: identical readback, lower
 * plugin_state receipt bytes and allocation; report CPU, GC and host-load spread.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { SessionActor } from "../../src/config/sessions/session-actor-contract.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    rounds: { type: "string", default: "10" },
    allocations: { type: "boolean", default: false },
    "plugin-only": { type: "boolean", default: false },
  },
});
assert(values.output, "Pass a fresh --output directory under .local");
const output = path.resolve(values.output);
assert(output.startsWith(`${path.resolve(".local")}${path.sep}`));
const rounds = Number(values.rounds);
assert(Number.isSafeInteger(rounds) && rounds > 0);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
process.env.TMPDIR = output;
const [
  { withOpenClawTestState },
  { createPluginStateKeyedStore },
  { getWorkerMessageMetrics },
  { openOpenClawAgentDatabase },
  { readOpenClawAgentDatabaseIdentity },
  { writeSessionEntry, readExactSessionEntryRow },
  { runSqliteImmediateTransactionSync },
  { createSessionActorFactory },
  { buildSessionTranscriptTurnExpectedState },
  { applySessionEntryOperation },
] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.js"),
  import("../../src/plugin-state/plugin-state-store.js"),
  import("../../src/infra/worker-message-metrics.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-agent-db-identity.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/infra/sqlite-transaction.js"),
  import("../../src/config/sessions/session-actor-durable.js"),
  import("../../src/config/sessions/session-transcript-turn-state.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry.js"),
]);
const metric = () =>
  getWorkerMessageMetrics().find(
    (row) => row.kind === "authority" && row.direction === "from_worker",
  );
const authority = { assertCurrent() {}, authorize() {} };
const pluginSizes = [
  ...Array<number>(24).fill(1024),
  ...Array<number>(12).fill(4096),
  ...Array<number>(6).fill(16384),
  ...Array<number>(2).fill(65536),
];
await withOpenClawTestState({ scenario: "minimal", label: "authority-census" }, async ({ env }) => {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const identity = readOpenClawAgentDatabaseIdentity(database);
  assert(typeof identity.identity === "string");
  const key = (index: number) => `agent:main:subagent:synthetic-authority-${index}`;
  runSqliteImmediateTransactionSync(database.db, () => {
    for (let index = 0; index < 10_000; index++) {
      writeSessionEntry(database, key(index), {
        sessionId: `synthetic-authority-${index}`,
        updatedAt: 1,
        label: `Synthetic finished subagent ${index}`,
        status: "done",
        ...(index < 8 ? { skillsSnapshot: { prompt: "s".repeat(32768), skills: [] } } : {}),
      });
    }
  });
  const factory = createSessionActorFactory({ agentId: "main", path: database.path, env });
  const actors: SessionActor[] = [];
  const actorCount = values["plugin-only"] ? 0 : 8;
  const stores = pluginSizes.map((size, index) => ({
    size,
    store: createPluginStateKeyedStore<{ body: string; revision: number }>(
      `synthetic-plugin-${index}`,
      { namespace: "snapshot", maxEntries: 16, env },
    ),
  }));
  const inspector = values.allocations ? new Session() : undefined;
  try {
    for (let index = 0; index < actorCount; index++) {
      const actor = await factory.acquire(
        {
          sessionKey: key(index),
          database: {
            kind: "file",
            physicalIdentity: identity.identity,
            birthtime: identity.birthtime,
            nativeLocation: database.path,
          },
        },
        { assertCurrent() {}, assertReadable() {} },
      );
      assert(!("kind" in actor));
      await actor.read(authority);
      actors.push(actor);
    }
    const operationCounts = { pluginWrites: 0, adoptRun: 0, completeTurn: 0, entryPatch: 0 };
    async function runRound(revision: number) {
      for (const { size, store } of stores) {
        await store.register("current", { body: "s".repeat(size), revision });
        operationCounts.pluginWrites++;
      }
      for (const [index, actor] of actors.entries()) {
        const sessionId = `synthetic-authority-${index}`;
        const runId = `synthetic-run-${revision}-${index}`;
        const before = actor.snapshot(authority);
        assert(before?.entry);
        const adopted = await actor.adoptRun(
          {
            commandId: `adopt-${revision}-${index}`,
            phaseId: runId,
            sessionId,
            expectedState: buildSessionTranscriptTurnExpectedState(before.entry),
            lifecycle: {},
            runId,
          },
          authority,
        );
        assert.equal(adopted.kind, "committed");
        operationCounts.adoptRun++;
        const active = actor.snapshot(authority);
        assert(active?.entry);
        const completed = await actor.completeTurn(
          {
            commandId: `complete-${revision}-${index}`,
            phaseId: runId,
            bookkeeping: {
              sessionId,
              lifecycleRevision: active.entry.lifecycleRevision ?? null,
              writerRunId: runId,
              expectedState: buildSessionTranscriptTurnExpectedState(active.entry),
              lifecycle: {},
            },
          },
          authority,
        );
        assert.equal(completed.kind, "committed");
        operationCounts.completeTurn++;
        await applySessionEntryOperation(
          { agentId: "main", storePath: database.path, sessionKey: key(index) },
          { kind: "fields", patch: { lastActivityAt: 1_800_000_000_000 + revision } },
          { preserveActivity: true, skipMaintenance: true },
        );
        operationCounts.entryPatch++;
      }
    }
    await runRound(-1);
    for (const field of Object.keys(operationCounts)) {
      Reflect.set(operationCounts, field, 0);
    }
    const initial = metric();
    const memoryBefore = process.memoryUsage();
    const loadBefore = loadavg();
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const gc = new GCProfiler();
    gc.start();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    for (let round = 0; round < rounds; round++) {
      await runRound(round);
    }
    const elapsedMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    const gcStats = gc.stop()?.statistics ?? [];
    const final = metric();
    const allocatedBytes = inspector
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
    const payloadBytesByRequestClass = Object.fromEntries(
      Object.entries(final?.payloadBytesByRequestClass ?? {}).map(([requestClass, bytes]) => [
        requestClass,
        bytes - (initial?.payloadBytesByRequestClass?.[requestClass] ?? 0),
      ]),
    );
    const result = {
      node: process.version,
      mode: values.allocations ? "allocation" : "timing",
      fixture: { sessions: 10_000, actors: actors.length, pluginSizes, rounds },
      operationCounts,
      authority: {
        payloadBytes: (final?.payloadBytes ?? 0) - (initial?.payloadBytes ?? 0),
        payloadBytesByRequestClass,
        unmeasuredMessages: (final?.unmeasuredMessages ?? 0) - (initial?.unmeasuredMessages ?? 0),
        syntheticMBPerMinuteByRequestClass: Object.fromEntries(
          Object.entries(payloadBytesByRequestClass).map(([requestClass, bytes]) => [
            requestClass,
            bytes / rounds / 1e6,
          ]),
        ),
      },
      elapsedMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      gc: {
        count: gcStats.length,
        totalMs: gcStats.reduce((sum, entry) => sum + entry.cost, 0) / 1000,
        maxMs: Math.max(0, ...gcStats.map((entry) => entry.cost)) / 1000,
        byKind: Object.fromEntries(
          [...new Set(gcStats.map((entry) => entry.gcType))].map((kind) => {
            const samples = gcStats.filter((entry) => entry.gcType === kind);
            return [
              kind,
              {
                count: samples.length,
                totalMs: samples.reduce((sum, entry) => sum + entry.cost, 0) / 1000,
                maxMs: Math.max(0, ...samples.map((entry) => entry.cost)) / 1000,
              },
            ];
          }),
        ),
      },
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      loadBefore,
      loadAfter: loadavg(),
    };
    for (const { size, store } of stores) {
      assert.deepEqual(await store.lookup("current"), {
        body: "s".repeat(size),
        revision: rounds - 1,
      });
    }
    for (let index = 0; index < actors.length; index++) {
      assert.equal(
        readExactSessionEntryRow(database, key(index))?.entry.lastActivityAt,
        1_800_000_000_000 + rounds - 1,
      );
    }
    writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } finally {
    inspector?.disconnect();
    for (const actor of actors) {
      await actor.release();
    }
  }
});
