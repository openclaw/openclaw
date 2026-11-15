/**
 * Measure lifecycle prepare reply decoding and frozen-preimage reuse at the production owner.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-lifecycle-prepare-measure.ts
 *
 * A real temporary SQLite database and lifecycle planning backend produce both replies:
 * the base request omits retainedEntry; the candidate supplies the current replica receipt.
 * The selected key is also listed as related, as in main-session reply initialization;
 * the owner regression verifies this shape uses the receipt after each real metadata write.
 * Five counterbalanced 5,000-operation timing passes precede separate allocation samples.
 * Candidate timing includes host replica lookup, request metadata and reply reconstruction.
 * Worker SQL, token validation, transport scheduling, builders and commit CAS are excluded.
 * Acceptance: identical reconstructed rows, lower reply bytes and main-isolate CPU/allocation.
 * No Gateway latency or throughput claim is implied.
 *
 * A final owner-residency pass offers 10,000 distinct ~47 KB synthetic session postimages
 * to the existing bounded replica. It creates no 10,000-row database and reports whole-isolate
 * post-GC heap/RSS, including receipt-registry overhead, plus surviving entry payload bytes.
 * This change adds no cache; the base and candidate use the same residency owner and limits.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { deserialize, serialize } from "node:v8";
import { readExactSessionEntryRow } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../src/config/sessions/session-accessor.sqlite-entry.js";
import {
  readSessionActorEntryFacts,
  retainSessionActorEntryFacts,
} from "../../src/config/sessions/session-actor-replica.js";
import {
  bindSqliteWorkerBackend,
  type SessionLifecyclePlanningOperations,
} from "../../src/config/sessions/session-lifecycle-projection.worker.js";
import { collectSessionEntryLookupKeys } from "../../src/config/sessions/store-entry.js";
import { sqliteSessionIdWriteScope } from "../../src/infra/sqlite-database-admission.js";
import { runWithSqliteWorkerStateContext } from "../../src/infra/sqlite-worker-state-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../src/state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

type Reply = SessionLifecyclePlanningOperations["prepare"]["output"];
const iterations = 5_000;
const skillCount = 320;
const sessionCount = 10_000;
const samplingInterval = 512;
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const inspector = new Session();
inspector.connect();
try {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env, stateDir }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:lifecycle-prepare-measure";
    replaceSessionEntrySync(
      { agentId: "main", storePath: database.path, env, sessionKey },
      {
        sessionId: "synthetic-lifecycle",
        updatedAt: 1,
        skillsSnapshot: {
          prompt: "Synthetic lifecycle instructions. ".repeat(1_400),
          skills: Array.from({ length: skillCount }, (_, index) => ({
            name: `synthetic-${index}`,
          })),
        },
      },
    );
    const identity = readOpenClawAgentDatabaseIdentity(database);
    const target = {
      sessionKey,
      database: {
        kind: "file" as const,
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: database.path,
      },
    };
    const backend = runWithSqliteWorkerStateContext(
      { environment: { ...env, OPENCLAW_STATE_DIR: stateDir } },
      () =>
        bindSqliteWorkerBackend(
          { agentId: "main" },
          { database: database.db, databasePath: database.path },
        ),
    );
    try {
      const input = {
        removals: [],
        upserts: [{ sessionKey, relatedSessionKeys: [sessionKey] }],
        archiveDirectory: "/synthetic/archives",
      };
      const base = backend.execute({ type: "prepare", input });
      const entry = readExactSessionEntryRow(database, sessionKey)!.entry;
      const expected: Reply = {
        store: { [sessionKey]: entry },
        selected: {
          removedKeysToArchive: new Set(),
          changedSessionKeys: new Set(),
          projectedRemovals: [],
        },
        archiveRecovery: { pending: false, databaseIdentity: identity.identity },
      };
      assert.deepEqual(base, expected);
      retainSessionActorEntryFacts(
        target.database,
        [{ sessionKey, facts: { entry, snapshots: "full" } }],
        "synthetic-reader",
      );
      const prepareRequest = () => {
        const retained = readSessionActorEntryFacts(target);
        assert(retained?.entry && retained.snapshots === "full");
        return {
          retained,
          input: {
            ...input,
            retainedEntry: {
              writeToken: retained.writeToken,
              writeScopes: [
                ...collectSessionEntryLookupKeys(sessionKey),
                ...retained.dependencySessionIds.map(sqliteSessionIdWriteScope),
              ],
            },
          },
        };
      };
      const candidate = backend.execute({ type: "prepare", input: prepareRequest().input });
      assert.deepEqual(candidate, { ...expected, store: {}, reuseEntry: true });
      const bytes = { base: serialize(base), candidate: serialize(candidate) };
      const operations = {
        base: () => deserialize(bytes.base) as Reply,
        candidate: () => {
          const request = prepareRequest();
          const decoded = deserialize(bytes.candidate) as Reply;
          assert(decoded.reuseEntry);
          decoded.store[sessionKey] = request.retained.entry!;
          return decoded;
        },
      };
      let last: Reply | undefined;
      const run = (operation: () => Reply) => {
        for (let index = 0; index < iterations; index++) {
          last = operation();
        }
      };
      const verify = () => {
        assert.deepEqual(last?.store, expected.store);
        assert.deepEqual(last?.selected, expected.selected);
        assert.deepEqual(last?.archiveRecovery, expected.archiveRecovery);
      };
      for (const operation of Object.values(operations)) {
        run(operation);
        verify();
      }
      const timing: Record<string, { cpuUsPerOperation: number; wallUsPerOperation: number }[]> = {
        base: [],
        candidate: [],
      };
      const hostLoadBefore = loadavg();
      for (let pass = 0; pass < 5; pass++) {
        const order = Object.entries(operations);
        if (pass % 2) {
          order.reverse();
        }
        for (const [name, operation] of order) {
          gc();
          const cpu = process.threadCpuUsage();
          const start = performance.now();
          run(operation);
          const wallMs = performance.now() - start;
          const used = process.threadCpuUsage(cpu);
          timing[name]!.push({
            cpuUsPerOperation: (used.user + used.system) / iterations,
            wallUsPerOperation: (wallMs * 1_000) / iterations,
          });
          verify();
        }
      }
      const allocation: Record<string, number> = {};
      for (const [name, operation] of Object.entries(operations)) {
        gc();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        run(operation);
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        allocation[name] =
          profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
        verify();
      }

      last = undefined;
      gc();
      const beforeResidency = process.memoryUsage();
      for (let index = 0; index < sessionCount; index++) {
        const key = `agent:main:synthetic-residency-${index}`;
        retainSessionActorEntryFacts(
          target.database,
          [
            {
              sessionKey: key,
              facts: {
                snapshots: "full",
                entry: {
                  sessionId: `synthetic-residency-${index}`,
                  updatedAt: 1,
                  skillsSnapshot: {
                    prompt: `${index}: ${"Synthetic lifecycle instructions. ".repeat(1_400)}`,
                    skills: [],
                  },
                },
              },
            },
          ],
          "synthetic-reader",
        );
      }
      // WeakRef targets survive their creation job even when the replica evicts them.
      await setImmediate();
      gc();
      const afterResidency = process.memoryUsage();
      let residentEntries = 0;
      let residentSerializedBytes = 0;
      for (let index = 0; index < sessionCount; index++) {
        const facts = readSessionActorEntryFacts({
          ...target,
          sessionKey: `agent:main:synthetic-residency-${index}`,
        });
        if (facts?.entry) {
          residentEntries++;
          residentSerializedBytes += serialize(facts.entry).byteLength;
        }
      }
      console.log(
        JSON.stringify(
          {
            node: process.version,
            iterationsPerPass: iterations,
            skillCount,
            timingPasses: 5,
            serializedBytes: { base: bytes.base.byteLength, candidate: bytes.candidate.byteLength },
            samplingInterval,
            timing,
            sampledBytesPerOperation: allocation,
            residency: {
              offeredSessionCount: sessionCount,
              residentEntries,
              residentSerializedBytes,
              before: beforeResidency,
              after: afterResidency,
              heapUsedDelta: afterResidency.heapUsed - beforeResidency.heapUsed,
            },
            hostLoadBefore,
            hostLoadAfter: loadavg(),
          },
          null,
          2,
        ),
      );
    } finally {
      await backend.close();
    }
  });
} finally {
  inspector.disconnect();
}
