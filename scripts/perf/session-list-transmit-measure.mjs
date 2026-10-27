/**
 * Session response serializer + WebSocket submission owner benchmark (no Gateway latency claim).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-list-transmit-measure.mjs \
 *   [--module /absolute/baseline-serialized-json.ts] [--mode timing|allocation] \
 *   [--iterations 3000] [--rows 500]
 * Run baseline/candidate in AB/BA order, separately for timing and sampled allocation.
 * Acceptance: byte-identical responses for every shape, fewer queued writes, lower CPU/allocation
 * without an adverse real-Gateway result. The sink uses Node's real Writable vector queue and
 * the production WebSocket transport, but discards bytes: excludes kernel I/O and client parsing.
 * 10k synthetic resident rows supply a 500-row response, plus conditional/delta/subscribe/history.
 * Warm immutable arrays are encoded before measurement. Sampling includes collected objects;
 * sampled bytes are estimates, GC in allocation mode is diagnostic, and tails are not gates.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    rows: { type: "string", default: "500" },
  },
});
const iterations = Number(values.iterations),
  rowCount = Number(values.rows);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(rowCount) && rowCount > 0 && rowCount <= 10_000);
assert(["timing", "allocation"].includes(values.mode));
assert(global.gc, "Run with --expose-gc");
const ownerUrl = new URL("../../src/gateway/serialized-json.ts", import.meta.url);
const source = readFileSync(values.module ?? ownerUrl, "utf8");
// Preserve the canonical module identity and relative imports for transport instanceof checks.
const transformed = transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code;
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === ownerUrl.href) {
      return { format: "module", shortCircuit: true, source: transformed };
    }
    return nextLoad(url, context);
  },
});
const owner = await import(ownerUrl.href);
const { createGatewayWebSocketTransport } =
  await import("../../src/gateway/server/ws-transport.ts");
hook.deregister();
const rows = Array.from({ length: 10_000 }, (_, index) => ({
  key: `agent:main:subagent:synthetic-${index}`,
  sessionId: `session-${index}`,
  updatedAt: 1_790_000_000_000 - index,
  displayName: `Synthetic task ${index} 雪🦞`,
  label: `Finished investigation ${index % 97}`,
  status: "idle",
  kind: "direct",
  modelProvider: "openai",
  model: "synthetic-mock",
  totalTokens: index * 7,
  contextTokens: 128_000,
  spawnedBy: `agent:main:dashboard-${index % 64}`,
  archived: index % 2 === 0,
  optional: undefined,
}));
const page = rows.slice(0, rowCount);
const sharedFacts = [{ modelProvider: "openai", model: "synthetic-mock", contextTokens: 128_000 }];
const sidebar = page.map(
  ({ modelProvider: _provider, model: _model, contextTokens: _tokens, ...row }) => ({
    ...row,
    sharedFacts: [0],
  }),
);
const changes = sidebar.slice(0, 3);
for (const vector of [page, sidebar, changes]) {
  owner.registerSerializedJsonArray(
    vector,
    vector.map((row) => JSON.stringify(row)),
  );
}
const list = (sessions) => ({
  ts: 1_790_000_000_000,
  path: "synthetic-store",
  count: 10_000,
  sessions,
  defaults: { modelProvider: "openai", model: "synthetic-mock", contextTokens: 128_000 },
  nextCursor: "synthetic-next",
  hasMore: true,
  totalCount: 10_000,
});
const messages = [{ role: "assistant", content: "Synthetic tool result 雪🦞".repeat(100) }];
const shapes = {
  full: list(page),
  sidebar: { ...list(sidebar), sharedFacts, rowsRevision: "revision-1" },
  unchanged: { ...list([]), rowsRevision: "revision-1", rowsUnchanged: true },
  delta: {
    ...list(changes),
    sharedFacts,
    rowsRevision: "revision-2",
    rowsDelta: { baseRevision: "revision-1", order: page.map((_, index) => index) },
  },
  subscribe: {
    subscribed: true,
    list: { ...list(sidebar), sharedFacts, rowsRevision: "revision-1" },
  },
  history: {
    subscribed: true,
    initialHistory: {
      ok: true,
      payload: {
        messages: new owner.SerializedJsonArray(Buffer.from(JSON.stringify(messages))),
        sessionKey: page[0].key,
        nextCursor: null,
      },
    },
  },
};
const socket = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, bufferedAmount: 0 });
let writes = 0,
  bytes = 0;
const sink = new Writable({
  write(chunk, _encoding, done) {
    writes++;
    bytes += chunk.byteLength;
    done();
  },
  writev(chunks, done) {
    writes += chunks.length;
    for (const { chunk } of chunks) {
      bytes += chunk.byteLength;
    }
    done();
  },
});
const transport = createGatewayWebSocketTransport(socket, sink, { compress: () => undefined });
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
}
const gcEntries = [];
const observer = new PerformanceObserver((entries) => gcEntries.push(...entries.getEntries()));
observer.observe({ entryTypes: ["gc"] });
const results = [];
for (const [shape, payload] of Object.entries(shapes)) {
  const frame = { type: "res", id: "synthetic-request", ok: true, payload, error: undefined };
  const expected = JSON.stringify(frame);
  const first = owner.serializeGatewayFrame(frame);
  assert.equal(first.toString(), expected, `${shape}: wire JSON differs`);
  const run = () => {
    const encoded = owner.serializeGatewayFrame(frame);
    transport.send(typeof encoded === "string" ? Buffer.from(encoded) : encoded, { binary: false });
  };
  for (let index = 0; index < 100; index++) {
    run();
  }
  await nextTurn();
  global.gc();
  await nextTurn();
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  writes = 0;
  bytes = 0;
  const hostLoad = loadavg();
  const started = performance.now(),
    cpu = process.threadCpuUsage();
  for (let index = 0; index < iterations; index++) {
    run();
    if (index % 100 === 99) {
      await nextTurn();
    }
  }
  const used = process.threadCpuUsage(cpu),
    ended = performance.now();
  let sampledBytes;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  await nextTurn();
  const collections = gcEntries.filter(
    (entry) => entry.startTime >= started && entry.startTime <= ended,
  );
  results.push({
    shape,
    iterations,
    responseBytes: Buffer.byteLength(expected),
    sha256: createHash("sha256").update(expected).digest("hex"),
    segments: typeof first === "string" ? 1 : first.segments.length,
    writesPerCall: writes / iterations,
    submittedBytesPerCall: bytes / iterations,
    threadCpuUsPerCall: (used.user + used.system) / iterations,
    wallUsPerCall: ((ended - started) * 1000) / iterations,
    sampledBytesPerCall: sampledBytes === undefined ? null : sampledBytes / iterations,
    gcMsPerCall: collections.reduce((sum, entry) => sum + entry.duration, 0) / iterations,
    gcCount: collections.length,
    hostLoad,
  });
}
observer.disconnect();
if (values.mode === "allocation") {
  inspector.disconnect();
}
sink.end();
console.log(
  JSON.stringify(
    {
      mode: values.mode,
      node: process.version,
      module: path.resolve(values.module ?? fileURLToPath(ownerUrl)),
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      residentRows: rows.length,
      responseRows: rowCount,
      results,
    },
    null,
    2,
  ),
);
