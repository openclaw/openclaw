/**
 * Synthetic cron.runs owner replay. No database, Gateway, or production data.
 * Before editing, freeze the baseline with:
 * node_modules/.bin/esbuild src/cron/run-history.ts --bundle --packages=external \
 *   --platform=node --format=esm --outfile=.local/cron-history-baseline.mjs
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-run-history-parse-measure.ts \
 *   --baseline .local/cron-history-baseline.mjs --mode differential
 * For serial A/A and interleaved A/B, use --module <baseline-or-candidate> with
 * --mode timing|allocation|cpu --iterations 5 --output <report.json>.
 * CPU/allocation profiles are saved beside the report. Timing excludes profiling.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseCronRunDetailJson } from "../../src/cron/run-history-detail.js";
import type { ReadCronRunHistoryPageOptions } from "../../src/cron/run-history.js";
import type { CronRunRecord } from "../../src/cron/store/run-history.types.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5" },
    module: { type: "string" },
    baseline: { type: "string" },
    output: { type: "string" },
  },
});
assert(["timing", "allocation", "cpu", "differential"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5,
});
const moduleUrl = values.module
  ? pathToFileURL(path.resolve(values.module))
  : new URL("../../src/cron/run-history.ts", import.meta.url);
const current: typeof import("../../src/cron/run-history.js") = await import(moduleUrl.href);
const storeKey = "synthetic-cron-store";
const records: CronRunRecord[] = Array.from({ length: 6000 }, (_, index) => {
  const jobId = `job-${index % 30}`;
  const startedAt = 1_800_000_000_000 + Math.floor(index / 3);
  const status = ["ok", "error", "skipped"][index % 3]!;
  const detail = {
    kind: "cron-run",
    storeKey: index % 101 === 0 ? "other-store" : storeKey,
    status,
    completionStatus: status === "ok" ? "succeeded" : "failed",
    runId: `public-${index}`,
    runAtMs: startedAt,
    durationMs: index % 100,
    nextRunAtMs: startedAt + 60_000,
    error: status === "error" ? "Synthetic timeout" : null,
    summary: index % 5 === 0 ? null : "Synthetic München summary",
    errorReason: status === "error" ? "timeout" : undefined,
    result: { outcome: "no_change" },
    sessionId: index % 10 === 0 ? "shared-session" : `session-${index}`,
    triggerFired: index % 7 !== 0,
    model: " synthetic-model ",
    provider: " synthetic-provider ",
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, cache_read_tokens: 0 },
    delivered: index % 4 === 0,
    deliveryStatus: ["delivered", "not-delivered", "unknown", "not-requested"][index % 4],
    deliveryError: index % 4 === 1 ? "Synthetic delivery error" : undefined,
    deliverySuppressionReason: index % 9 === 0 ? "silent" : undefined,
    failureNotificationDelivery: { status: "delivered", delivered: true, error: "" },
    delivery: { intended: { channel: "telegram" }, messageToolSentTo: [{ channel: "slack" }] },
    diagnostics: {
      summary: "Synthetic diagnostics",
      entries: [
        {
          ts: startedAt,
          source: "tool",
          severity: "warn",
          message: "Synthetic diagnostic " + "x".repeat(300),
        },
      ],
    },
    triggerState: { private: "must not reach wire" },
  };
  const record: CronRunRecord = {
    id: `record-${String(index).padStart(5, "0")}`,
    jobId,
    runId: `cron:${jobId}:${startedAt}:receipt-${index}`,
    agentId: index % 2 ? "main" : "other",
    sessionKey: `agent:main:cron:${jobId}`,
    createdAt: startedAt,
    endedAt: startedAt + (index % 100),
    status: status === "ok" ? "succeeded" : "failed",
    summary: "Legacy row fallback",
    error: "Legacy row error",
    detail: parseCronRunDetailJson(JSON.stringify(detail)),
  };
  // Released shapes: missing completion, malformed optional values, absent detail,
  // quiet evaluations, unknown kinds, blank public IDs, and ambiguous link aliases.
  if (index % 11 === 0) {
    record.detail = {
      kind: "cron-run",
      storeKey,
      status,
      runAtMs: startedAt,
      sessionId: "shared-session",
      runId: index % 22 === 0 ? " " : `public-${index}`,
      completionStatus: "partial",
      summary: 42,
      delivery: [],
      deliveryStatus: "invalid",
      failureNotificationDelivery: { status: "invalid" },
      usage: { input_tokens: -1, output_tokens: 0, future_tokens: 9 },
      durationMs: 1.5,
      nextRunAtMs: -1,
      triggerFired: false,
    };
  }
  if (index % 103 === 0) {
    record.detail = { storeKey, triggerFired: false };
  }
  if (index % 107 === 0) {
    record.detail = { storeKey, kind: "retired" };
  }
  if (index % 109 === 0) {
    record.detail = undefined;
  }
  if (index % 113 === 0) {
    record.jobId = " ";
  }
  if (index % 127 === 0) {
    record.endedAt = -1;
  }
  return record;
});
// An exact public ID must win over a different record's session alias.
records.push({
  ...records[1]!,
  id: "exact-alias",
  detail: {
    kind: "cron-run",
    storeKey,
    runId: "session-1",
    status: "skipped",
  },
});
const filters: Partial<ReadCronRunHistoryPageOptions>[] = [
  {},
  { status: "error" },
  { statuses: ["ok", "skipped"] },
  { deliveryStatus: "not-requested" },
  { deliveryStatuses: ["delivered", "unknown"] },
  { query: "MÜNCHEN" },
  { query: "diagnostic" },
  { query: "telegram" },
  { query: "fallback" },
  { query: "missing" },
  { query: "matched", queryMatchedTaskIds: new Set(["record-00001", "record-00007"]) },
  { runId: "public-1" },
  { runId: "session-1" },
  { runId: "shared-session" },
  { runId: "cron:job-1:1800000000000" },
  { runId: records[2]!.runId },
  { jobId: "job-1", agentId: "main" },
  { entryFilter: (entry) => entry.status !== "skipped" && entry.runId !== "public-1" },
  { status: "error", deliveryStatus: "not-delivered", query: "timeout" },
];
const defaults = { storeKey, jobNameById: { "job-1": "Synthetic job name" } };
if (values.mode === "differential") {
  assert(values.baseline, "--baseline is required");
  const baseline: typeof current = await import(pathToFileURL(path.resolve(values.baseline)).href);
  let cases = 0;
  const hash = createHash("sha256");
  for (const sortDir of ["asc", "desc"] as const) {
    for (const view of ["full", "summary"] as const) {
      for (const offset of [0, 1, 199, 5999, 9999]) {
        for (const filter of filters) {
          const options = {
            ...defaults,
            sortDir,
            view,
            offset,
            limit: offset % 2 ? 200 : 7,
            ...filter,
          };
          const expected = baseline.selectCronRunHistoryPage(records, options);
          const actual = current.selectCronRunHistoryPage(records, options);
          const wire = JSON.stringify(actual.page);
          assert.equal(wire, JSON.stringify(expected.page), `page case ${cases}`);
          assert.deepEqual(
            actual.records.map((row) => row.id),
            expected.records.map((row) => row.id),
          );
          hash.update(wire);
          cases++;
        }
      }
    }
  }
  console.log(JSON.stringify({ cases, records: records.length, checksum: hash.digest("hex") }));
} else {
  assert(values.output, "--output is required");
  // Mixed response pages plus the metadata-only projection returned by the history worker.
  const candidates = records.map((record) => ({
    ...record,
    detail:
      record.detail && typeof record.detail === "object" && !Array.isArray(record.detail)
        ? Object.fromEntries(
            Object.entries(record.detail).filter(([key]) =>
              [
                "kind",
                "storeKey",
                "status",
                "deliveryStatus",
                "runId",
                "runAtMs",
                "sessionId",
              ].includes(key),
            ),
          )
        : record.detail,
  }));
  const workload = () => {
    let total = 0;
    for (const input of [records, candidates]) {
      for (const filter of [filters[0], filters[1], filters[4], filters[6], filters[12]]) {
        const page = current.selectCronRunHistoryPage(input, {
          ...defaults,
          ...filter,
          limit: 50,
        }).page;
        total += page.total + page.entries.length;
      }
    }
    return total;
  };
  for (let warmup = 0; warmup < 2; warmup++) {
    workload();
  }
  global.gc?.();
  const inspector = new Session();
  if (values.mode === "allocation") {
    await startCollectedHeapSampling(inspector, 16384);
  }
  if (values.mode === "cpu") {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const hostLoadBefore = loadavg();
  const cpu = process.cpuUsage();
  const started = performance.now();
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    checksum += workload();
  }
  const elapsedMs = performance.now() - started;
  const usedCpu = process.cpuUsage(cpu);
  let sampledBytes: number | null = null;
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = sumSampledHeapBytes(profile.head);
    await writeFile(`${output}.heapprofile`, JSON.stringify(profile));
  }
  if (values.mode === "cpu") {
    const { profile } = await inspector.post("Profiler.stop");
    await writeFile(`${output}.cpuprofile`, JSON.stringify(profile));
  }
  inspector.disconnect();
  const report = {
    mode: values.mode,
    module: moduleUrl.href,
    node: process.version,
    records: records.length,
    iterations,
    pagesPerIteration: 10,
    checksum,
    elapsedMs,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    sampledBytes,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
