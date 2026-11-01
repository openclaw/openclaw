/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/placement-retirement-replies.mjs
 *   [--rows 10000] [--iterations 10] [--pairs 5]
 * Synthetic, offline owner benchmark: real placement SQL + wire serialization and
 * host deserialization. Base reads full records; candidate reads session identities.
 * Five AB/BA pairs, untraced timing then separate allocation sampling. Accept lower
 * reply bytes/allocation without a consistent CPU regression. No Gateway throughput
 * claim. All fixture writes precede measurement; no production state is accessed.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
import {
  readWorkerPlacementIdentitiesInDatabase,
  readWorkerPlacementsInDatabase,
} from "../../src/gateway/worker-environments/placement-row-codec.ts";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.ts";

const { values } = parseArgs({
  options: {
    rows: { type: "string", default: "10000" },
    iterations: { type: "string", default: "10" },
    pairs: { type: "string", default: "5" },
  },
});
const rows = Number(values.rows);
const iterations = Number(values.iterations);
const pairs = Number(values.pairs);
for (const value of [rows, iterations, pairs]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(globalThis.gc);
mkdirSync(resolve(".local"), { recursive: true });
const root = mkdtempSync(resolve(".local/placement-replies-"));
const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
const inspector = new Session();
inspector.connect();
try {
  const insert = database.db.prepare(`INSERT INTO worker_session_placements
    (session_id, agent_id, session_key, state, execution_mode, created_at_ms,
     updated_at_ms, state_changed_at_ms)
    VALUES (?, ?, ?, 'requested', 'worker-turn', 1000, 1000, 1000)`);
  database.db.exec("BEGIN");
  for (let index = 0; index < rows; index++) {
    const id = `synthetic-session-${String(index).padStart(6, "0")}`;
    const agent = `agent-${index % 40}`;
    insert.run(id, agent, `agent:${agent}:${id}`);
  }
  database.db.exec("COMMIT");
  const readers = {
    base: () => readWorkerPlacementsInDatabase(database.db),
    candidate: () => readWorkerPlacementIdentitiesInDatabase(database.db),
  };
  const identities = (records) =>
    records.map(({ sessionId, agentId, sessionKey }) => ({
      sessionId,
      agentId,
      sessionKey,
    }));
  assert.deepEqual(identities(readers.base()), deserialize(serialize(readers.candidate())));
  for (const mode of ["timing", "allocation"]) {
    for (let pair = 0; pair < pairs; pair++) {
      for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
        const read = readers[arm];
        const operation = () => deserialize(serialize(read()));
        operation();
        globalThis.gc();
        if (mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const hostLoad = loadavg();
        const cpu = process.threadCpuUsage();
        const start = performance.now();
        for (let index = 0; index < iterations; index++) {
          assert.equal(operation().length, rows);
        }
        const elapsedMs = performance.now() - start;
        const used = process.threadCpuUsage(cpu);
        let allocatedBytes;
        if (mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const pending = [profile.head];
          allocatedBytes = 0;
          while (pending.length) {
            const node = pending.pop();
            allocatedBytes += node.selfSize;
            pending.push(...node.children);
          }
        }
        console.log(
          JSON.stringify({
            mode,
            pair: pair + 1,
            arm,
            rows,
            iterations,
            hostLoad,
            elapsedMs,
            cpuMsPerScan: (used.user + used.system) / 1000 / iterations,
            allocatedBytesPerScan:
              allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
            replyBytes: serialize(read()).byteLength,
          }),
        );
      }
    }
  }
} finally {
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
  rmSync(root, { recursive: true, force: true });
}
