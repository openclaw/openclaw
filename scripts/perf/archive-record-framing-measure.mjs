// Usage: node --expose-gc scripts/perf/archive-record-framing-measure.mjs BASE_ROOT CANDIDATE_ROOT
// Five counterbalanced passes, 2,000 archives/arm/pass, 100 synthetic 1-KiB messages/archive.
// Exact owner source, 64-KiB chunks, UTF-8 decoding and JSON parsing included on both arms.
// Timing and collected-object allocation sampling run separately; results are JSON lines.
// This owner probe does not measure whole-Gateway latency or archive-worker module retention.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GCProfiler } from "node:v8";

const [base, candidate] = process.argv.slice(2);
assert(base && candidate && globalThis.gc, "provide BASE_ROOT CANDIDATE_ROOT and --expose-gc");
const owners = {};
for (const [side, root] of Object.entries({ base, candidate })) {
  const file = path.resolve(root, "src/config/sessions/session-accessor.sqlite-archive-stream.ts");
  owners[side] = (await import(pathToFileURL(file).href)).readTranscriptArchiveRecords;
  console.log(
    JSON.stringify({ side, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }),
  );
}
const messages = Array.from({ length: 100 }, (_, id) => ({
  type: "message",
  id,
  message: { role: id % 2 ? "assistant" : "user", content: "Synthetic 🦞 ".padEnd(1024, "x") },
}));
const archive = Buffer.from(messages.map((message) => JSON.stringify(message)).join("\n"));
async function* chunks() {
  for (let offset = 0; offset < archive.length; offset += 64 * 1024) {
    yield archive.subarray(offset, offset + 64 * 1024);
  }
}
async function run(owner, iterations) {
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    for await (const record of owner(chunks())) {
      // Baseline decoded at its caller; candidate decodes before yielding.
      checksum += JSON.parse(typeof record === "string" ? record : record.toString("utf8")).id;
    }
  }
  assert.equal(checksum, iterations * 4950);
}
const inspector = new Session();
inspector.connect();
try {
  for (const owner of Object.values(owners)) {
    await run(owner, 100);
  }
  for (const mode of ["timing", "allocation"]) {
    for (let pass = 0; pass < 5; pass++) {
      for (const side of pass % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
        globalThis.gc();
        const retainedBefore = process.memoryUsage().heapUsed;
        const hostLoad = loadavg();
        if (mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const gc = new GCProfiler();
        gc.start();
        const cpuBefore = process.threadCpuUsage();
        const started = performance.now();
        await run(owners[side], 2000);
        const elapsedMs = performance.now() - started;
        const cpu = process.threadCpuUsage(cpuBefore);
        const collections = gc.stop()?.statistics ?? [];
        const allocation =
          mode === "allocation"
            ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
                (sum, sample) => sum + sample.size,
                0,
              )
            : undefined;
        globalThis.gc();
        console.log(
          JSON.stringify({
            side,
            mode,
            pass,
            iterations: 2000,
            records: 200000,
            hostLoad,
            elapsedMs,
            cpuMs: (cpu.user + cpu.system) / 1000,
            allocationBytes: allocation,
            gcMs: collections.reduce((sum, entry) => sum + entry.cost / 1000, 0),
            gcCount: collections.length,
            gcMaxMs: Math.max(0, ...collections.map((entry) => entry.cost / 1000)),
            gcKinds: Object.fromEntries(
              Object.entries(Object.groupBy(collections, (entry) => entry.gcType)).map(
                ([kind, entries]) => [
                  kind,
                  {
                    count: entries.length,
                    totalMs: entries.reduce((sum, entry) => sum + entry.cost / 1000, 0),
                    maxMs: Math.max(0, ...entries.map((entry) => entry.cost / 1000)),
                  },
                ],
              ),
            ),
            retainedBefore,
            retainedAfter: process.memoryUsage().heapUsed,
          }),
        );
      }
    }
  }
} finally {
  inspector.disconnect();
}
