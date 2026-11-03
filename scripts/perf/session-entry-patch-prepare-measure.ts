/**
 * Compare decoding a complete patch-preparation reply with the existing retained-facts owner.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-entry-patch-prepare-measure.ts
 *   --reply-file <synthetic-patch-prepare.bin>
 * The input is a synthetic V8 reply from sqlite-reply-census-preload.mjs. A temporary
 * database publishes its entry through the real reader before measurement. Five
 * counterbalanced 5,000-operation timing passes are separate from heap sampling.
 * This measures main-isolate preparation only: it excludes worker SQL/transport and
 * the unchanged updater clone and commit CAS. No Gateway latency claim is implied.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
import type { SqliteLifecycleTargetSnapshot } from "../../src/config/sessions/session-accessor.sqlite-entry-equality.js";
import { replaceSessionEntrySync } from "../../src/config/sessions/session-accessor.sqlite-entry.js";
import { withSessionEntryWorker } from "../../src/config/sessions/session-accessor.sqlite-replacement-worker.js";
import { readRetainedSessionEntryFacts } from "../../src/config/sessions/session-entry-read-facts.js";
import { readSessionEntryReadOnlyInWorker } from "../../src/config/sessions/session-entry-read-runtime.js";
import { openOpenClawAgentDatabase } from "../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const { values } = parseArgs({ options: { "reply-file": { type: "string" } } });
assert(values["reply-file"], "--reply-file must name a synthetic patch-preparation reply");
// The census captures this private typed reply from the generated fixture's worker.
const captured = deserialize(readFileSync(values["reply-file"])) as SqliteLifecycleTargetSnapshot;
assert(captured.length === 1 && captured[0]?.entry.sessionId, "Expected one synthetic entry");
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const iterations = 5_000;
const samplingInterval = 512;
const inspector = new Session();
inspector.connect();
try {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const options = { agentId: "main", path: database.path, env };
    const sessionKey = "agent:main:patch-prepare-measure";
    const scope = { agentId: "main", storePath: database.path, env, sessionKey };
    const entry = captured[0]!.entry;
    if (entry.parentSessionKey) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: entry.parentSessionKey },
        { sessionId: "synthetic-parent", updatedAt: 1 },
      );
    }
    replaceSessionEntrySync(scope, entry);
    const current = await readSessionEntryReadOnlyInWorker(scope);
    assert(current);
    const expected = [{ sessionKey, entry: current }];
    const bytes = serialize(expected);
    await withSessionEntryWorker(
      options,
      undefined,
      () => {},
      async (execution, source) => {
        await execution.prepare(source);
        const retained = () => {
          const generation = execution.capturePreparedGenerationClaim();
          assert(generation);
          return readRetainedSessionEntryFacts(
            options,
            { sessionKeys: [sessionKey], projection: "full" },
            generation,
          )?.entries;
        };
        assert.deepEqual(retained(), expected);
        const operations = { decode: () => deserialize(bytes) as unknown, retained };
        let last: unknown;
        const run = (operation: () => unknown) => {
          for (let index = 0; index < iterations; index++) {
            last = operation();
          }
        };
        const timing: Record<string, { cpuUsPerOperation: number; wallNsPerOperation: number }[]> =
          {
            decode: [],
            retained: [],
          };
        for (const operation of Object.values(operations)) {
          run(operation);
        }
        const hostLoadBefore = loadavg();
        for (let pass = 0; pass < 5; pass++) {
          const order = Object.entries(operations);
          if (pass % 2) {
            order.reverse();
          }
          for (const [name, operation] of order) {
            gc();
            const cpu = process.threadCpuUsage();
            const at = performance.now();
            run(operation);
            const elapsed = performance.now() - at;
            const used = process.threadCpuUsage(cpu);
            assert.deepEqual(last, expected);
            timing[name]!.push({
              cpuUsPerOperation: (used.user + used.system) / iterations,
              wallNsPerOperation: (elapsed * 1e6) / iterations,
            });
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
          assert.deepEqual(last, expected);
          allocation[name] =
            profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
        }
        console.log(
          JSON.stringify(
            {
              scope:
                "main-thread decode versus current retained entry lookup; excludes unchanged patch work",
              node: process.version,
              iterationsPerPass: iterations,
              serializedBytes: bytes.byteLength,
              samplingInterval,
              timing,
              sampledBytesPerOperation: allocation,
              hostLoadBefore,
              hostLoadAfter: loadavg(),
              memory: process.memoryUsage(),
            },
            null,
            2,
          ),
        );
      },
    );
  });
} finally {
  inspector.disconnect();
}
