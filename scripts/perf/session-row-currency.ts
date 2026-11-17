/**
 * Currency owner cost, excluding fixture construction, presentation and transport.
 * Run on each revision, alternating base/candidate; --allocation is a separate pass:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-currency.ts \
 *   --sessions 15000 --iterations 1000 [--allocation]
 * Repeat at 60000 rows; --mixed-case exercises opaque uppercase tail bytes.
 * Currency batch: 272 checks (16 recipients × 17 rows), not a complete publication.
 * List shape: one currency check per resident row (an upper bound, not RPC latency).
 * Accept identical decisions with lower CPU/allocation; whole-Gateway effects are unmeasured.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { isIncognitoSessionKey } from "../../packages/session-url-contract/src/session-key.js";
import {
  create,
  isCurrentGeneration,
  type Row,
} from "../../src/gateway/session-row-projection-record.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "15000" },
    iterations: { type: "string", default: "1000" },
    allocation: { type: "boolean" },
    "mixed-case": { type: "boolean" },
  },
});
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "sessions",
  fallback: 15000,
  min: 17,
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  fallback: 1000,
  min: 1,
});
const rows: Row[] = Array.from({ length: sessions }, (_, index) => {
  const key = `agent:main:subagent:${values["mixed-case"] ? "Synthetic-Session" : "synthetic-session"}-${index}`;
  const entry = { sessionId: `session-${index}`, lifecycleRevision: "revision-1", updatedAt: 1 };
  return {
    ...create(
      {
        key,
        agentId: "main",
        storeTarget: { agentId: "main", storePath: "/synthetic/sessions.sqlite" },
      },
      entry,
    ),
    entry,
  };
});
const current = rows.map((row) => ({ ...row }));
const operations = {
  currencyBatch: () => {
    let accepted = 0;
    for (let recipient = 0; recipient < 16; recipient++) {
      for (let depth = 0; depth < 17; depth++) {
        const index = sessions - depth - 1;
        if (isCurrentGeneration(rows[index]!, current[index])) {
          accepted++;
        }
      }
    }
    return accepted;
  },
  listCurrency: () => {
    let accepted = 0;
    for (let index = 0; index < rows.length; index++) {
      if (isCurrentGeneration(rows[index]!, current[index])) {
        accepted++;
      }
    }
    return accepted;
  },
  ordinaryKeyClassification: () => {
    let accepted = 0;
    for (const row of rows) {
      if (!isIncognitoSessionKey(row.key)) {
        accepted++;
      }
    }
    return accepted;
  },
};
for (const [name, run] of Object.entries(operations)) {
  const expected = name === "currencyBatch" ? 16 * 17 : sessions;
  for (let warm = 0; warm < 100; warm++) {
    assert.equal(run(), expected);
  }
  global.gc?.();
  const inspector = new Session();
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 32768);
  }
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  let accepted = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    accepted += run();
  }
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  assert.equal(accepted, expected * iterations);
  const sampledBytes = values.allocation
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  if (values.allocation) {
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      name,
      sessions,
      iterations,
      mixedCase: Boolean(values["mixed-case"]),
      decisions: accepted,
      elapsedMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      cpuUsPerOperation: (used.user + used.system) / iterations,
      sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      hostLoad: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
}
