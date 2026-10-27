/**
 * Lifecycle finish request/reply encoding at the existing owner boundary.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-lifecycle-finish-measure.ts
 * Repeat with --allocation for a separate sampled-allocation pass.
 *
 * A temporary SQLite planning backend and the production upsert builder prepare a
 * compound removal/upsert replacing a ~48 KiB saved prompt with 40 skills. Baseline echoes
 * the builder result through finish; candidate retains that array on the host.
 * Five counterbalanced passes perform 5,000 operations per arm. Request encoding
 * and reply decoding/reconstruction measure main-thread work; request decoding and
 * reply encoding measure worker work separately. Allocation is sampled JS heap;
 * native V8 serializer buffers are reported separately as wire bytes. SQL, queueing, admission, commits,
 * and Gateway latency are excluded. No full-Gateway performance claim is implied.
 * Acceptance: identical result values, fewer request/reply bytes, lower main-thread
 * CPU/allocation without moving encoding cost to the worker. Preserve every CAS
 * preimage in the subsequent commit, which is outside this planning-only change.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
import { replaceSessionEntrySync } from "../../src/config/sessions/session-accessor.sqlite-entry.js";
import {
  buildProjectedLifecycleUpserts,
  readProjectedLifecycleStore,
  selectProjectedLifecycleRemovals,
} from "../../src/config/sessions/session-accessor.sqlite-lifecycle-state.js";
import type { ProjectedLifecycleMutation } from "../../src/config/sessions/session-accessor.sqlite-lifecycle-types.js";
import { bindSqliteWorkerBackend } from "../../src/config/sessions/session-lifecycle-projection.worker.js";
import { classifyWorkerRequest } from "../../src/infra/sqlite-worker-request-class.js";
import { runWithSqliteWorkerStateContext } from "../../src/infra/sqlite-worker-state-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../src/state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const { values } = parseArgs({ options: { allocation: { type: "boolean", default: false } } });
const iterations = 5_000;
const passes = 5;
const samplingInterval = 32_768;
const gc = global.gc;
assert(gc, "Run with --expose-gc");
type Sample = { cpuUsPerOperation: number; wallUsPerOperation: number; bytesPerOperation?: number };
type Arm = "base" | "candidate";
const stages = [
  "mainRequestEncode",
  "mainReplyDecode",
  "workerRequestDecode",
  "workerReplyEncode",
] as const;
type Stage = (typeof stages)[number];
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
}
try {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env, stateDir }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:synthetic-lifecycle-upsert";
    const removedKey = "agent:main:synthetic-lifecycle-remove";
    const original = {
      sessionId: "synthetic-retained",
      updatedAt: 1,
      skillsSnapshot: {
        prompt: "Synthetic saved lifecycle instructions. ".repeat(1_200),
        skills: Array.from({ length: 40 }, (_, index) => ({ name: `synthetic-skill-${index}` })),
      },
    };
    for (const [key, entry] of [
      [sessionKey, original],
      [removedKey, { sessionId: "synthetic-removed", updatedAt: 1 }],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", storePath: database.path, env, sessionKey: key },
        entry,
      );
    }
    const backend = runWithSqliteWorkerStateContext(
      { environment: { ...env, OPENCLAW_STATE_DIR: stateDir } },
      () =>
        bindSqliteWorkerBackend(
          { agentId: "main" },
          { database: database.db, databasePath: database.path },
        ),
    );
    try {
      const preparationInput = {
        removals: [{ sessionKey: removedKey, expectedSessionId: "synthetic-removed" }],
        upserts: [{ sessionKey }],
        archiveDirectory: "/synthetic/archives",
      };
      const store = readProjectedLifecycleStore(database, preparationInput);
      const prepared = {
        store,
        selected: selectProjectedLifecycleRemovals(database, store, preparationInput.removals),
        archiveRecovery: {
          pending: false,
          databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
        },
      };
      assert.deepEqual(backend.execute({ type: "prepare", input: preparationInput }), prepared);
      assert.equal(prepared.selected.projectedRemovals.length, 1);
      const upsertedEntries = await buildProjectedLifecycleUpserts(
        prepared.store,
        prepared.selected,
        [
          {
            sessionKey,
            buildEntry: ({ currentEntry }) => {
              assert(currentEntry?.skillsSnapshot);
              return {
                ...currentEntry,
                label: "Updated",
                skillsSnapshot: {
                  ...currentEntry.skillsSnapshot,
                  prompt: `Updated ${currentEntry.skillsSnapshot.prompt}`,
                },
              };
            },
          },
        ],
      );
      const candidateInput = {
        store: prepared.store,
        selected: prepared.selected,
        archiveDirectory: "/synthetic/archives",
      };
      const withoutEcho = backend.execute({ type: "finish", input: candidateInput });
      const projected = { ...withoutEcho, upsertedEntries };
      const publication = (input: object) => ({
        type: "database.domain.publish",
        input: {
          id: "synthetic-publication-id",
          moduleUrl: "file:///synthetic/session-lifecycle-projection.worker.js",
          input: { agentId: "main" },
          command: { type: "finish", input },
        },
      });
      const commands = {
        base: publication({
          ...prepared,
          upsertedEntries,
          archiveDirectory: "/synthetic/archives",
        }),
        candidate: publication(candidateInput),
      };
      const replies = { base: projected, candidate: withoutEcho };
      const requests = { base: serialize(commands.base), candidate: serialize(commands.candidate) };
      const responses = { base: serialize(replies.base), candidate: serialize(replies.candidate) };
      assert.deepEqual({ ...deserialize(responses.candidate), upsertedEntries }, projected);
      const samples: Record<Stage, Record<Arm, Sample[]>> = {
        mainRequestEncode: { base: [], candidate: [] },
        mainReplyDecode: { base: [], candidate: [] },
        workerRequestDecode: { base: [], candidate: [] },
        workerReplyEncode: { base: [], candidate: [] },
      };
      const hostLoadBefore = loadavg();
      let last: unknown;
      const run = (stage: Stage, arm: Arm, count: number) => {
        for (let index = 0; index < count; index++) {
          if (stage === "mainRequestEncode") {
            last = serialize(commands[arm]);
          } else if (stage === "mainReplyDecode") {
            const reply = deserialize(responses[arm]) as ProjectedLifecycleMutation;
            last = arm === "candidate" ? { ...reply, upsertedEntries } : reply;
          } else if (stage === "workerRequestDecode") {
            last = deserialize(requests[arm]);
          } else {
            last = serialize(replies[arm]);
          }
        }
      };
      for (const stage of stages) {
        for (const arm of ["base", "candidate"] as const) {
          run(stage, arm, 500);
        }
        for (let pass = 0; pass < passes; pass++) {
          const order: Arm[] = pass % 2 ? ["candidate", "base"] : ["base", "candidate"];
          for (const arm of order) {
            last = undefined;
            gc();
            if (values.allocation) {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const cpu = process.threadCpuUsage();
            const started = performance.now();
            run(stage, arm, iterations);
            const elapsed = performance.now() - started;
            const used = process.threadCpuUsage(cpu);
            const sample: Sample = {
              cpuUsPerOperation: (used.user + used.system) / iterations,
              wallUsPerOperation: (elapsed * 1_000) / iterations,
            };
            if (values.allocation) {
              const { profile } = await inspector.post("HeapProfiler.stopSampling");
              sample.bytesPerOperation =
                profile.samples.reduce((sum, entry) => sum + entry.size, 0) / iterations;
            }
            samples[stage][arm].push(sample);
            const expected =
              stage === "mainRequestEncode"
                ? requests[arm]
                : stage === "mainReplyDecode"
                  ? projected
                  : stage === "workerRequestDecode"
                    ? commands[arm]
                    : responses[arm];
            assert.deepEqual(last, expected);
          }
        }
      }
      console.log(
        JSON.stringify(
          {
            mode: values.allocation ? "allocation" : "timing",
            node: process.version,
            iterationsPerPass: iterations,
            passes,
            samplingInterval,
            skills: 40,
            promptBytes: Buffer.byteLength(original.skillsSnapshot.prompt),
            requestClass: classifyWorkerRequest(commands.base.type, commands.base.input),
            operation: "lifecycle.finish",
            bytes: {
              request: { base: requests.base.byteLength, candidate: requests.candidate.byteLength },
              reply: { base: responses.base.byteLength, candidate: responses.candidate.byteLength },
            },
            samples,
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
  if (values.allocation) {
    inspector.disconnect();
  }
}
