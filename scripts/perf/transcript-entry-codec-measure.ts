/**
 * Transcript cohort consumer's classification owner; no SQL, transport, or clone timing.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-entry-codec-measure.ts \
 *   --window 2048 --operations 500 --output <json> [--allocations] [--owner-file <baseline.ts>]
 * Run five counterbalanced baseline/candidate pairs plus unchanged-source A/A controls.
 * Acceptance: identical classification and original payloads, lower CPU and allocation,
 * and no latency regression outside the A/A spread. Profile separately with --cpu-prof.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    window: { type: "string", default: "2048" },
    operations: { type: "string", default: "500" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(values.output, "--output is required");
const windowSize = parseStrictIntegerOption({
  raw: values.window,
  label: "--window",
  min: 1,
  fallback: 2048,
});
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 500,
});
const eventCount = 34_000;
assert(windowSize <= eventCount);
const ownerUrl = new URL("../../src/config/sessions/session-entry-codec.ts", import.meta.url);
const ownerHash = hash("sha256", readFileSync(values["owner-file"] ?? ownerUrl));
const replaced = registerPerfOwnerReplacement(ownerUrl.href, values["owner-file"]);
const { partitionSessionFileEntries } =
  await import("../../src/config/sessions/session-entry-codec.js");
assert(!values["owner-file"] || replaced());
const events = Array.from({ length: eventCount }, (_, index) => ({
  type: "message",
  id: `message-${index}`,
  parentId: index ? `message-${index - 1}` : null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: index % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `Synthetic ${index}: ${"transcript payload ".repeat(64)}` }],
    timestamp: index,
    model: "synthetic",
    provider: "synthetic",
    api: "synthetic",
    usage: { input: 100, output: 50, cacheRead: 80, cacheWrite: 0 },
    stopReason: "stop",
  },
}));
const header = { type: "session", id: "synthetic", version: 4, cwd: "/synthetic" };
const windows = Array.from({ length: 8 }, (_, index) => {
  const end = Math.max(windowSize, eventCount - index * 64);
  return [header, ...events.slice(end - windowSize, end)];
});
const expectedHash = hash("sha256", JSON.stringify(windows));
function read(index: number) {
  const input = windows[index % windows.length]!;
  const result = partitionSessionFileEntries(input);
  assert.equal(result.fileEntries.length, windowSize + 1);
  assert.equal(result.opaqueEntries.length, 0);
  assert.equal(result.fileEntries.at(-1), input.at(-1));
  return result;
}
for (let index = 0; index < 100; index++) {
  read(index);
}
global.gc?.();
const inspector = values.allocations ? new Session() : undefined;
inspector?.connect();
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
try {
  if (inspector) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const latencies: number[] = [];
  const hostBefore = loadavg();
  const cpuBefore = process.cpuUsage();
  for (let index = 0; index < operations; index++) {
    const start = performance.now();
    read(index);
    latencies.push(performance.now() - start);
  }
  const cpu = process.cpuUsage(cpuBefore);
  const hostAfter = loadavg();
  const profile = inspector
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  assert.equal(hash("sha256", JSON.stringify(windows)), expectedHash);
  assert.equal(hash("sha256", readFileSync(values["owner-file"] ?? ownerUrl)), ownerHash);
  latencies.sort((a, b) => a - b);
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        node: process.version,
        ownerHash,
        fixtureHash: expectedHash,
        eventCount,
        windowSize,
        operations,
        fixtureBytes: Buffer.byteLength(JSON.stringify(events)),
        hostBefore,
        hostAfter,
        cpuUsPerRead: (cpu.user + cpu.system) / operations,
        medianMs: latencies[Math.ceil(operations * 0.5) - 1],
        p95Ms: latencies[Math.ceil(operations * 0.95) - 1],
        meanMs: latencies.reduce((sum, value) => sum + value, 0) / operations,
        sampledBytesPerRead: profile ? allocated(profile.head) / operations : undefined,
      },
      null,
      2,
    )}\n`,
  );
  if (profile) {
    await writeFile(`${output}.heapprofile`, JSON.stringify(profile));
  }
  console.log(output);
} finally {
  inspector?.disconnect();
}
