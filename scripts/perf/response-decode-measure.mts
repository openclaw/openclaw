/**
 * Count UTF-8 decoding and event parsing through fetch -> SSE preparation -> OpenAI SDK.
 * Synthetic Responses API text/tool events only; loopback HTTP, no credentials.
 * node --import ./scripts/tsx.mjs scripts/perf/response-decode-measure.mts \
 *   --source ./src/agents/provider-transport-sse.ts --responses 20 --events 1024
 * Compare frozen base/candidate owners in fresh processes, counterbalancing launch order.
 * Counts and sampled allocation include the entire receiving path. Allocation is a
 * separate inspector pass; never use its CPU/GC timings as a performance gate.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Stream } from "openai/core/streaming";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "./src/agents/provider-transport-sse.ts" },
    responses: { type: "string", default: "20" },
    port: { type: "string", default: "41749" },
    events: { type: "string", default: "1024" },
    sanitize: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
    unicode: { type: "boolean", default: false },
  },
});
const port = Number(values.port);
assert(Number.isSafeInteger(port) && port >= 40000 && port <= 65535);
const responses = Number(values.responses);
const events = Number(values.events);
assert(Number.isSafeInteger(responses) && responses > 0);
assert(Number.isSafeInteger(events) && events > 0);
const { prepareOpenAISdkSseResponse } = await import(
  pathToFileURL(path.resolve(values.source)).href
);
const wireEvents = [
  {
    type: "response.created",
    response: { id: "resp_synthetic", status: "in_progress", output: [] },
  },
  ...Array.from({ length: events }, (_, index) => ({
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    item_id: "msg_synthetic",
    delta: `${index}: ${(values.unicode ? "Synthetic UTF-8 🦞 response. " : "Synthetic ASCII response. ").repeat(8)}`,
  })),
  {
    type: "response.output_item.added",
    output_index: 1,
    item: {
      type: "function_call",
      id: "fc_synthetic",
      call_id: "call_synthetic",
      name: "read",
      arguments: "",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: "fc_synthetic",
    delta: '{"path":"README.md"}',
  },
  {
    type: "response.output_item.done",
    output_index: 1,
    item: {
      type: "function_call",
      id: "fc_synthetic",
      call_id: "call_synthetic",
      name: "read",
      arguments: '{"path":"README.md"}',
    },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_synthetic",
      status: "completed",
      output: [],
      usage: { input_tokens: 1000, output_tokens: events, total_tokens: 1000 + events },
    },
  },
];
const payload = Buffer.from(
  wireEvents
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n: heartbeat\n\n`)
    .join(""),
);
// Prepared chunks keep fixture serialization out of all measured passes.
const chunks = Array.from({ length: Math.ceil(payload.length / 4093) }, (_, i) =>
  payload.subarray(i * 4093, (i + 1) * 4093),
);
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) {
    res.write(chunk);
  }
  res.end();
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string" && address.port >= 40000);
const url = `http://127.0.0.1:${address.port}/v1/responses`;
let active = false;
let decodedBytes = 0;
let decodeCalls = 0;
let parsedEvents = 0;
let comments = 0;
// oxlint-disable-next-line typescript/unbound-method -- Called with the original decoder receiver below and restored in finally.
const decode = TextDecoder.prototype.decode;
TextDecoder.prototype.decode = function (input, options) {
  if (active) {
    decodedBytes += input?.byteLength ?? 0;
    decodeCalls++;
  }
  return decode.call(this, input, options);
};
const parse = JSON.parse;
JSON.parse = function (text, reviver) {
  if (active && typeof text === "string" && text.startsWith('{"type":"response.')) {
    parsedEvents++;
  }
  return Reflect.apply(parse, JSON, [text, reviver]);
};
let gcMs = 0;
let gcCount = 0;
let gcMaxMs = 0;
const gcByKind: Record<number, { count: number; totalMs: number; maxMs: number }> = {};
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const kind = (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind;
    const group = (gcByKind[kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
    group.count++;
    group.totalMs += entry.duration;
    group.maxMs = Math.max(group.maxMs, entry.duration);
    gcMs += entry.duration;
    gcCount++;
    gcMaxMs = Math.max(gcMaxMs, entry.duration);
  }
});
async function receive(verify = false) {
  const response = prepareOpenAISdkSseResponse(await fetch(url), {
    sanitize: values.sanitize,
    synthesizeJsonAsSse: false,
    onSseComment: () => {
      comments++;
    },
  });
  let count = 0;
  for await (const event of Stream.fromSSEResponse(response, new AbortController())) {
    if (verify) {
      assert.deepEqual(event, wireEvents[count]);
    }
    count++;
  }
  assert.equal(count, wireEvents.length);
}
const inspector = new Session();
try {
  await receive(true);
  comments = 0;
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  active = true;
  for (let i = 0; i < responses; i++) {
    await receive();
  }
  active = false;
  const durationMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  let allocatedBytes: number | undefined;
  if (values.allocation) {
    const result = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = result.profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  const streamedBytes = responses * payload.length;
  assert.equal(comments, responses * wireEvents.length);
  assert.equal(parsedEvents, responses * wireEvents.length);
  console.log(
    JSON.stringify({
      source: values.source,
      sanitize: values.sanitize,
      unicode: values.unicode,
      allocation: values.allocation,
      responses,
      eventsPerResponse: wireEvents.length,
      streamedBytes,
      decodedBytes,
      decodeRatio: decodedBytes / streamedBytes,
      decodeCalls,
      parsedEvents,
      comments,
      allocatedBytes,
      allocatedPerStreamedByte:
        allocatedBytes === undefined ? undefined : allocatedBytes / streamedBytes,
      durationMs,
      cpuMs: (used.user + used.system) / 1000,
      gcMs,
      gcCount,
      gcMaxMs,
      gcByKind,
      memory: process.memoryUsage(),
    }),
  );
} finally {
  active = false;
  TextDecoder.prototype.decode = decode;
  JSON.parse = parse;
  observer.disconnect();
  inspector.disconnect();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
