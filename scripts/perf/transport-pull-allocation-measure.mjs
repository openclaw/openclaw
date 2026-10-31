/**
 * Local, synthetic owner benchmark for the pull formerly in ai-transport-host.ts.
 * Current production chain: ai-transport-host -> buildGuardedModelFetch ->
 * wrapGuardedBodyStream -> prepareOpenAISdkSseResponse (these real owners below).
 * Run: node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/transport-pull-allocation-measure.mjs <artifact-dir> [marked] [sse-source]
 * Optional sse-source is an absolute path to a pristine baseline owner module.
 * Use an empty second argument for unmarked baseline/candidate measurements.
 * No Gateway, credentials, remote hosts, MessagePorts, or provider API calls.
 * Fixtures are prepared before sampling; network/SDK JSON parsing is excluded.
 * The three modes are attribution controls, NOT baseline/candidate optimizations.
 * 8 warmed streams/mode; 4 KiB sampling includes objects collected by both GCs.
 * Marked mode labels native decoder/encoder calls and counts their input/output.
 * Hashes verify expected wire bytes, including Unicode split across chunks.
 * firstTokenMs measures availability of the complete first text-delta SSE event
 * from stream construction, not real provider/Gateway request latency.
 * Stop without production changes if dominant costs implement required semantics.
 * Any proposed fix requires identical output/backpressure and five alternating
 * baseline/candidate samples of allocation per MB and first delivered event.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { cpus, hostname, loadavg } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { wrapGuardedBodyStream } from "../../src/infra/net/guarded-body-stream.ts";

const [outputDir, marked, sourcePath] = process.argv.slice(2);
const { prepareOpenAISdkSseResponse } = await import(
  sourcePath
    ? pathToFileURL(resolve(sourcePath)).href
    : "../../src/agents/provider-transport-sse.ts"
);
assert(outputDir, "artifact directory required");
assert(!marked || marked === "marked");
mkdirSync(outputDir, { recursive: true });
const events = Array.from(
  { length: 4096 },
  (_, i) =>
    `data: ${JSON.stringify({
      id: "synthetic-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "synthetic-model",
      choices: [
        {
          index: 0,
          delta: {
            content: `Step ${i}: inspect the transport, preserve ordering, and verify café 🦞 東京.\n`,
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
);
const accepted = events.join("") + "data: [DONE]\n\n";
const firstEventBytes = Buffer.byteLength(events[0]);
const heartbeat = ": heartbeat\n\n";
const wire = Buffer.from(
  events.map((event, i) => (i % 32 === 0 ? heartbeat + event : event)).join("") +
    "data: [DONE]\n\n",
);
const sizes = [127, 1024, 4093, 511, 2048];
const chunks = [];
for (let offset = 0, i = 0; offset < wire.length; i++) {
  const end = Math.min(wire.length, offset + sizes[i % sizes.length]);
  chunks.push(wire.subarray(offset, end));
  offset = end;
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const expected = { sanitize: digest(accepted), observe: digest(wire), passthrough: digest(wire) };
let counts;
const NativeTextDecoder = TextDecoder;
const NativeTextEncoder = TextEncoder;
if (marked) {
  globalThis.TextDecoder = class AttributedTextDecoder extends NativeTextDecoder {
    decode(input, options) {
      const result = super.decode(input, options);
      counts.decodeCalls++;
      counts.decodedChars += result.length;
      return result;
    }
  };
  globalThis.TextEncoder = class AttributedTextEncoder extends NativeTextEncoder {
    encode(input) {
      const result = super.encode(input);
      counts.encodeCalls++;
      counts.encodedBytes += result.byteLength;
      return result;
    }
  };
}
function resetCounts() {
  counts = { decodeCalls: 0, decodedChars: 0, encodeCalls: 0, encodedBytes: 0 };
}
async function stream(mode, paced = false, checkBackpressure = false) {
  let sourceIndex = 0,
    releases = 0,
    refreshes = 0,
    comments = 0,
    reads = 0;
  const start = performance.now();
  const source = new ReadableStream(
    {
      async pull(controller) {
        if (sourceIndex === chunks.length) {
          controller.close();
          return;
        }
        if (paced && sourceIndex % 32 === 0) {
          await delay(1);
        }
        controller.enqueue(chunks[sourceIndex++]);
      },
    },
    { highWaterMark: 0 },
  );
  const managed = wrapGuardedBodyStream({
    body: source,
    cleanup: () => {
      releases++;
    },
    refreshTimeout: () => {
      refreshes++;
    },
  });
  const response = prepareOpenAISdkSseResponse(
    new Response(managed, {
      headers: { "content-type": "text/event-stream" },
    }),
    {
      sanitize: mode === "sanitize",
      synthesizeJsonAsSse: false,
      ...(mode !== "passthrough"
        ? {
            onSseComment: () => {
              comments++;
            },
          }
        : {}),
    },
  );
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let bytes = 0,
    firstByteMs,
    firstTokenMs;
  const pullCheckpoints = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    firstByteMs ??= performance.now() - start;
    bytes += chunk.value.byteLength;
    if (bytes >= firstEventBytes + (mode === "sanitize" ? 0 : heartbeat.length)) {
      firstTokenMs ??= performance.now() - start;
    }
    reads++;
    hash.update(chunk.value);
    if (checkBackpressure && [1, 2, 10, 100].includes(reads)) {
      await delay(1);
      const pulled = sourceIndex;
      await delay(1);
      assert.equal(sourceIndex, pulled, "upstream must stop while downstream is paused");
      pullCheckpoints.push({ reads, pulled });
    }
  }
  assert.equal(hash.digest("hex"), expected[mode]);
  assert.equal(releases, 1);
  assert.equal(refreshes, chunks.length);
  assert.equal(comments, mode === "passthrough" ? 0 : 128);
  return {
    bytes,
    reads,
    sourceReads: sourceIndex,
    comments,
    firstByteMs,
    firstTokenMs,
    elapsedMs: performance.now() - start,
    pullCheckpoints,
  };
}
function summarize(profile) {
  const rows = [];
  const visit = (node, stack) => {
    const f = node.callFrame;
    const name = `${f.functionName || "[native/anonymous]"} (${f.url || "[native]"}:${f.lineNumber + 1})`;
    const path = [...stack, name];
    if (node.selfSize) {
      rows.push({ bytes: node.selfSize, stack: path });
    }
    for (const child of node.children ?? []) {
      visit(child, path);
    }
  };
  visit(profile.head, []);
  return {
    sampledBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    topStacks: rows.toSorted((a, b) => b.bytes - a.bytes).slice(0, 40),
  };
}
const results = {
  host: hostname(),
  node: process.version,
  cpus: cpus().length,
  loadBefore: loadavg(),
  marked: Boolean(marked),
  source: sourcePath ?? "current",
  inputBytesPerStream: wire.length,
  chunksPerStream: chunks.length,
  samplingInterval: 4096,
  includeCollected: true,
  modes: {},
};
resetCounts();
for (const mode of ["passthrough", "observe", "sanitize"]) {
  await stream(mode);
  await stream(mode);
  globalThis.gc?.();
  resetCounts();
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const samples = [];
    for (let i = 0; i < 8; i++) {
      samples.push(await stream(mode));
    }
    globalThis.gc?.();
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const allocation = summarize(profile);
    const profilePath = resolve(outputDir, `${mode}${marked ? "-marked" : ""}.heapprofile`);
    writeFileSync(profilePath, JSON.stringify(profile));
    results.modes[mode] = {
      ...allocation,
      samples,
      codecCounts: { ...counts },
      profilePath,
      sampledBytesPerInputMB: allocation.sampledBytes / ((wire.length * samples.length) / 1e6),
    };
  } finally {
    inspector.disconnect();
  }
}
// Paced first-byte measurements are separate from allocation instrumentation.
for (const mode of ["passthrough", "observe", "sanitize"]) {
  results.modes[mode].paced = [];
  for (let index = 0; index < 5; index++) {
    results.modes[mode].paced.push(await stream(mode, true));
  }
  results.modes[mode].backpressure = await stream(mode, false, true);
}
results.loadAfter = loadavg();
const summaryPath = resolve(outputDir, `summary${marked ? "-marked" : ""}.json`);
writeFileSync(summaryPath, JSON.stringify(results, null, 2) + "\n");
console.log(summaryPath);
for (const [mode, value] of Object.entries(results.modes)) {
  console.log(
    mode,
    JSON.stringify({
      sampledBytesPerInputMB: value.sampledBytesPerInputMB,
      codecCounts: value.codecCounts,
      paced: value.paced,
      top: value.topStacks.slice(0, 8),
    }),
  );
}
