/**
 * Checkpoint envelope ownership, through the exported production operations.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-checkpoint-retention.ts \
 *   --mode retention --count 10000 --output .local/checkpoint-retention.json
 * Repeat with --mode allocation in a separate process. Baseline overrides:
 * --json-owner-file <saved-transcript-json.ts> --checkpoint-file <saved-code-mode-checkpoint.ts>.
 * Alternate fresh baseline/candidate processes. Retention keeps both the original
 * admitted messages and their stamped projections alive; the delta is additional
 * retained storage per projection, not total transcript size or a leak estimate.
 * Setup, validation, and forced GC are outside the timed operation loop. Allocation
 * sampling includes collected objects and distorts timing. This owner microbenchmark
 * does not replace the separate built-Gateway Team-shaped stress campaign.
 */
import assert from "node:assert/strict";
import { createHash, hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "json-owner-file": { type: "string" },
    "checkpoint-file": { type: "string" },
    count: { type: "string", default: "10000" },
    mode: { type: "string", default: "retention" },
    output: { type: "string" },
  },
});
assert(values.output, "--output is required");
assert(values.mode === "retention" || values.mode === "allocation", "Invalid --mode");
assert(global.gc, "Run with --expose-gc");
const gc = global.gc;
const count = parseStrictIntegerOption({
  raw: values.count,
  label: "--count",
  min: 1,
  fallback: 10000,
});
const sources = [
  {
    url: new URL("../../src/config/sessions/transcript-json.ts", import.meta.url),
    file: values["json-owner-file"],
    loaded: false,
  },
  {
    url: new URL("../../src/agents/code-mode-checkpoint.ts", import.meta.url),
    file: values["checkpoint-file"],
    loaded: false,
  },
];
registerHooks({
  load(url, context, nextLoad) {
    const source = sources.find((candidate) => candidate.url.href === url && candidate.file);
    if (!source?.file) {
      return nextLoad(url, context);
    }
    source.loaded = true;
    const loaded = nextLoad(pathToFileURL(path.resolve(source.file)).href, context);
    return { format: loaded.format, source: loaded.source, shortCircuit: true };
  },
});
const { normalizeTranscriptJsonValue: normalize } =
  await import("../../src/config/sessions/transcript-json.js");
const { prepareCodeModeCheckpoint, persistCodeModeCheckpoint } =
  await import("../../src/agents/code-mode-checkpoint.js");
const { cloneTranscriptView } = await import("../../src/config/sessions/transcript-snapshot.js");
for (const source of sources) {
  assert(
    !source.file || source.loaded,
    `Requested source override was not loaded: ${source.url.pathname}`,
  );
}

function fixture(index: number) {
  const message = {
    role: "toolResult",
    toolName: index % 2 ? "wait" : "exec",
    toolCallId: `synthetic-call-${index}`,
    content: [{ type: "text", text: `${index}:`.padEnd(8192, "x") }],
    details: {
      nested: { output: `${index}:`.padEnd(4096, "y"), values: [null, 7, "🦞\ud800 lone \udfff"] },
    },
  };
  // Ordinary shell results also stamp an explicit null checkpoint.
  prepareCodeModeCheckpoint(message, {});
  normalize({ type: "message", id: `entry-${index}`, message }, "");
  return message;
}
type Message = ReturnType<typeof fixture>;
function project(message: Message): Message {
  const stamped = persistCodeModeCheckpoint(message, message);
  // The append preparer performs this second admission after checkpoint stamping.
  return normalize(stamped, "") as Message;
}
function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}
for (let index = 0; index < 32; index++) {
  project(fixture(index));
}
const originals = Array.from({ length: count }, (_, index) => fixture(index));
const projections: Message[] = [];
projections.length = count;
gc();
gc();
const before = process.memoryUsage();
const hostLoadBefore = loadavg();
const inspector = values.mode === "allocation" ? new Session() : undefined;
let allocationBytes: number | undefined;
inspector?.connect();
try {
  if (inspector) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    projections[index] = project(originals[index]!);
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  if (inspector) {
    allocationBytes = allocatedBytes(
      (await inspector.post("HeapProfiler.stopSampling")).profile.head,
    );
  }
  gc();
  gc();
  const after = process.memoryUsage();
  const hostLoadAfter = loadavg();
  const wireHash = createHash("sha256");
  let sharedPayloads = 0;
  for (let index = 0; index < count; index++) {
    const original = originals[index]!;
    const projected = projections[index]!;
    const expected = JSON.stringify({ ...original, __openclaw: { codeModeCheckpoint: null } });
    assert.equal(
      JSON.stringify(projected),
      expected,
      "Checkpoint projection changed transcript bytes",
    );
    assert.equal(Object.hasOwn(original, "__openclaw"), false);
    assert.equal(Object.isFrozen(projected), false);
    assert(Object.isFrozen(projected.content[0]));
    sharedPayloads += Number(
      projected.content === original.content && projected.details === original.details,
    );
    wireHash.update(expected);
  }
  const detached = cloneTranscriptView(projections[0]!, { shareImmutablePayloads: false });
  detached.content[0]!.text = "caller mutation";
  detached.details.nested.output = "caller mutation";
  assert.notEqual(projections[0]!.content[0]!.text, "caller mutation");
  assert.notEqual(originals[0]!.details.nested.output, "caller mutation");
  const result = {
    scope:
      "Owner checkpoint projections; originals and projections both retained; no Gateway claim",
    mode: values.mode,
    node: process.version,
    count,
    warmupOperations: 32,
    sourceSha256: sources.map((source) =>
      hash("sha256", readFileSync(source.file ?? source.url), "hex"),
    ),
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuUsPerProjection: (cpu.user + cpu.system) / count,
    hostLoadBefore,
    hostLoadAfter,
    sharedPayloads,
    wireSha256: wireHash.digest("hex"),
    ...(values.mode === "retention"
      ? {
          retainedBytes: after.heapUsed - before.heapUsed,
          retainedBytesPerProjection: (after.heapUsed - before.heapUsed) / count,
          externalBytes: after.external - before.external,
          rssBefore: before.rss,
          rssAfter: after.rss,
        }
      : {
          sampledAllocationBytes: allocationBytes,
          sampledBytesPerProjection: allocationBytes! / count,
          samplingInterval: 32768,
        }),
  };
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(result));
} finally {
  inspector?.disconnect();
}
