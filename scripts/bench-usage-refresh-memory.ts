// Opt-in, synthetic real-worker regression. Run on a Testbox with Node 24+:
// pnpm bench:usage-refresh-memory [--expect-oom]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Worker } from "node:worker_threads";
import { parseStrictIntegerOption } from "./lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "24000" },
    "payload-kib": { type: "string", default: "48" },
    "max-heap-mib": { type: "string", default: "384" },
    "expect-oom": { type: "boolean", default: false },
  },
});
const count = parseStrictIntegerOption({
  raw: values.events,
  fallback: 24000,
  min: 1,
  label: "--events",
});
const payloadBytes =
  1024 *
  parseStrictIntegerOption({
    raw: values["payload-kib"],
    fallback: 48,
    min: 1,
    label: "--payload-kib",
  });
const maxHeapBytes =
  1024 *
  1024 *
  parseStrictIntegerOption({
    raw: values["max-heap-mib"],
    fallback: 384,
    min: 1,
    label: "--max-heap-mib",
  });
assert.ok(payloadBytes < 4 * 1024 * 1024 - 1024, "Each event must fit the production 4 MiB limit");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-memory-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, "{}\n");
const agentId = "usage-memory-benchmark";
const sessionId = "synthetic-large-session";
const timestamp = "2026-09-23T12:00:00.000Z";
const referenceFile = path.join(root, "reference.jsonl");

type HeapSample = {
  threadId: number;
  limitMiB: number | undefined;
  peakHeapBytes: number;
  samples: number;
  pending: boolean;
};
const heaps = new Map<Worker, HeapSample>();
let measuring = false;
function observeWorker(worker: Worker): void {
  if (!measuring) {
    return;
  }
  heaps.set(worker, {
    threadId: worker.threadId,
    limitMiB: worker.resourceLimits?.maxOldGenerationSizeMb,
    peakHeapBytes: 0,
    samples: 0,
    pending: false,
  });
}
process.on("worker", observeWorker);
function sampleHeaps(): void {
  for (const [worker, sample] of heaps) {
    if (sample.pending || worker.threadId < 0) {
      continue;
    }
    sample.pending = true;
    void worker
      .getHeapStatistics()
      .then((heap) => {
        sample.peakHeapBytes = Math.max(sample.peakHeapBytes, heap.used_heap_size);
        sample.samples++;
      })
      .catch(() => {})
      .finally(() => {
        sample.pending = false;
      });
  }
}
function errorChain(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = Reflect.get(error, "code");
  return `${error.name}: ${code ?? ""} ${error.message}${error.cause ? `; ${errorChain(error.cause)}` : ""}${error instanceof AggregateError ? error.errors.map(errorChain).join("; ") : ""}`;
}

const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../src/state/openclaw-state-db.js");
const { prepareTranscriptPayload } = await import("../src/config/sessions/transcript-payload.js");
const { createSessionEntryWithTranscript } =
  await import("../src/config/sessions/session-accessor.entry-mutation.js");
const { waitForSessionTranscriptIndexReconcilesInStateDir } =
  await import("../src/config/sessions/session-transcript-reconcile.js");
const { closeSessionTranscriptReconcileWorkerPool } =
  await import("../src/config/sessions/session-transcript-reconcile-pool.js");
const { formatSqliteSessionFileMarker } =
  await import("../src/config/sessions/legacy-sqlite-marker.js");
const { prepareUsageCostWorker, runUsageCostWorker } =
  await import("../src/infra/session-cost-usage-worker-runtime.js");
const { decodeUsageCostRollup, decodeUsageCostRollupEnvelope, USAGE_COST_ROLLUP_SCOPE } =
  await import("../src/infra/session-cost-usage-rollup-codec.js");
const { rotateDatabaseWorkers, costRefreshLane } =
  await import("../src/config/sessions/session-transcript-worker-resources.js");

try {
  const database = openOpenClawAgentDatabase({ agentId });
  const sessionKey = `agent:${agentId}:benchmark`;
  const created = await createSessionEntryWithTranscript(
    { agentId, sessionKey, storePath: database.path },
    () => ({ ok: true, entry: { sessionId, updatedAt: Date.parse(timestamp) } }),
    { cwd: root },
  );
  assert.ok(created.ok);
  await waitForSessionTranscriptIndexReconcilesInStateDir(root);
  database.db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(sessionId);
  const insert = database.db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let decodedBytes = 0;
  let identityRows = 0;
  let compressedRows = 0;
  const referenceFd = fs.openSync(referenceFile, "w");
  const fixtureStarted = performance.now();
  try {
    // Fixture-only direct writes keep setup bounded, with no live operator state.
    database.db.exec("BEGIN");
    for (let start = 0; start < count; start += 128) {
      const referenceBatch: string[] = [];
      for (let index = start; index < Math.min(count, start + 128); index++) {
        const event = {
          type: "message",
          id: `event-${index}`,
          parentId: index === 0 ? null : `event-${index - 1}`,
          timestamp,
          message: {
            role: "assistant",
            provider: "synthetic",
            model: "fixture",
            content: [{ type: "text", text: "Synthetic benchmark message" }],
            usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
          },
        };
        // Text is irrelevant to the usage rollup; the independent JSONL backend
        // supplies the same contribution without retaining the padded payload.
        referenceBatch.push(JSON.stringify(event));
        event.message.content[0]!.text += "x".repeat(payloadBytes);
        const json = JSON.stringify(event);
        decodedBytes += Buffer.byteLength(json);
        const payload =
          index % 4 === 0
            ? {
                event_json: json,
                event_zstd: null,
                event_utf8_bytes: Buffer.byteLength(json),
                navigation_json: null,
              }
            : prepareTranscriptPayload(database.db, json, event);
        if (payload.event_zstd) {
          compressedRows++;
        } else {
          identityRows++;
        }
        insert.run(
          sessionId,
          index + 1,
          payload.event_json,
          payload.event_zstd,
          payload.event_utf8_bytes,
          payload.navigation_json,
          Date.parse(timestamp),
        );
      }
      fs.writeSync(referenceFd, `${referenceBatch.join("\n")}\n`);
    }
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  } finally {
    fs.closeSync(referenceFd);
  }
  assert.ok(
    identityRows > 0 && compressedRows > 0,
    "Fixture must exercise identity and compressed payloads",
  );
  console.log(
    JSON.stringify({
      phase: "fixture",
      events: count,
      decodedBytes,
      identityRows,
      compressedRows,
      fixtureMs: performance.now() - fixtureStarted,
    }),
  );
  const marker = formatSqliteSessionFileMarker({ agentId, sessionId, storePath: database.path });
  const prepared = prepareUsageCostWorker({
    agentId,
    databasePath: database.path,
    storePath: database.path,
    sessionFiles: [marker, referenceFile],
  });
  function readRollup(key: string) {
    const row = database.db
      .prepare("SELECT value_json, blob FROM cache_entries WHERE scope = ? AND key = ?")
      .get(USAGE_COST_ROLLUP_SCOPE, key);
    assert.ok(
      row && typeof row.value_json === "string" && row.blob instanceof Uint8Array,
      "Worker must persist a rollup",
    );
    const envelope = decodeUsageCostRollupEnvelope(row.value_json);
    assert.ok(envelope);
    const entry = decodeUsageCostRollup(row.value_json, envelope.pricingFingerprint, row.blob);
    assert.ok(entry);
    return entry;
  }
  assert.equal(
    (await runUsageCostWorker(prepared, { kind: "refresh", sessionFiles: [referenceFile] })).kind,
    "refresh",
  );
  const reference = readRollup(referenceFile);
  assert.equal(reference.parsedRecords, count);
  assert.equal(reference.countedRecords, count);
  const bucket = Object.values(reference.rollup.buckets)[0];
  assert.equal(bucket?.totals.totalTokens, count * 10);
  assert.equal(bucket?.totals.totalCost, count);
  // Start a fresh production refresh worker so its whole lifetime is observed.
  await rotateDatabaseWorkers(costRefreshLane);
  measuring = true;
  const sampler = setInterval(sampleHeaps, 10);
  const started = performance.now();
  let failure: unknown;
  try {
    assert.equal(
      (await runUsageCostWorker(prepared, { kind: "refresh", sessionFiles: [marker] })).kind,
      "refresh",
    );
  } catch (error) {
    failure = error;
  } finally {
    measuring = false;
    clearInterval(sampler);
  }
  const refreshMs = performance.now() - started;
  const workers = [...heaps.values()].map(({ pending: _pending, ...sample }) => sample);
  const peakHeapBytes = Math.max(
    0,
    ...workers.filter((worker) => worker.limitMiB === 512).map((worker) => worker.peakHeapBytes),
  );
  console.log(
    JSON.stringify({
      phase: "refresh",
      refreshMs,
      peakHeapBytes,
      heapBoundBytes: maxHeapBytes,
      workers,
      outcome: failure ? errorChain(failure) : "success",
      sampling: "Node Worker.getHeapStatistics every 10 ms; observed peak, not an allocation total",
    }),
  );
  assert.ok(peakHeapBytes > 0, "Production 512 MiB refresh worker must be sampled");
  if (values["expect-oom"]) {
    assert.match(
      errorChain(failure),
      /ERR_WORKER_OUT_OF_MEMORY|reaching memory limit|heap out of memory/i,
    );
  } else {
    assert.ifError(failure);
    const actual = readRollup(marker);
    assert.deepEqual(actual.rollup, reference.rollup);
    assert.equal(actual.parsedRecords, reference.parsedRecords);
    assert.equal(actual.countedRecords, reference.countedRecords);
    assert.equal(actual.checkpoint.kind, "sqlite");
    if (actual.checkpoint.kind === "sqlite") {
      assert.equal(actual.checkpoint.maxSeq, count);
      assert.equal(actual.checkpoint.eventCount, count);
      assert.equal(actual.checkpoint.visibleLeafId, `event-${count - 1}`);
    }
    assert.ok(peakHeapBytes < maxHeapBytes, `Peak ${peakHeapBytes} exceeded ${maxHeapBytes}`);
    console.log(
      JSON.stringify({
        phase: "equality",
        rollupEqual: true,
        countedRecords: actual.countedRecords,
        totalTokens: count * 10,
        totalCost: count,
        rollupSha256: createHash("sha256").update(JSON.stringify(actual.rollup)).digest("hex"),
        reference:
          "JSONL worker's existing 128-record aggregation; independently checked token/cost totals",
      }),
    );
  }
} finally {
  process.off("worker", observeWorker);
  await closeSessionTranscriptReconcileWorkerPool();
  await closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
  fs.rmSync(root, { recursive: true, force: true });
}
