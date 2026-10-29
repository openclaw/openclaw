/**
 * Replay a recorded synthetic long response through the real Responses HTTP owner.
 * node --import ./scripts/tsx.mjs scripts/perf/openai-sse-decode-measure.ts
 *   --mode timing --turns 20 --output .local/sse-base.json
 *   [--fixture .local/recorded.sse] [--owner /absolute/path/to/replay-owner.ts]
 * Use --large-frame to record a 1 MiB output-item snapshot instead of 3,000 deltas.
 * Use --mixed for alternating text/tool-argument deltas and mixed CR/LF framing.
 * The first run records <output>.sse. Reuse those exact bytes for both revisions.
 * Team-shaped replay: --mixed --events 10000 --snapshot-every 2500 (64 KiB snapshots).
 * --frames-only measures the public framing adapter, including one-read-per-event
 * behavior with --chunk-size 128. Its --owner must name transport-stream-shared.ts.
 * Run timing/allocation separately in alternating order; hashes are outside measurement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import type { Model } from "../../packages/ai/src/types.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    turns: { type: "string", default: "20" },
    owner: { type: "string" },
    events: { type: "string", default: "3000" },
    "snapshot-every": { type: "string", default: "0" },
    "chunk-size": { type: "string", default: "1024" },
    "frames-only": { type: "boolean", default: false },
    fixture: { type: "string" },
    mixed: { type: "boolean", default: false },
    "large-frame": { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(values.output, "--output is required");
assert(values.mode === "timing" || values.mode === "allocation");
const turns = Number(values.turns);
assert(Number.isSafeInteger(turns) && turns > 0);
const eventCount = Number(values.events);
const snapshotEvery = Number(values["snapshot-every"]);
const chunkSize = Number(values["chunk-size"]);
assert(Number.isSafeInteger(eventCount) && eventCount > 0);
assert(Number.isSafeInteger(snapshotEvery) && snapshotEvery >= 0);
assert(Number.isSafeInteger(chunkSize) && chunkSize > 0);
const {
  iterateSseFrames,
}: typeof import("../../packages/ai/src/transports/transport-stream-shared.js") = await import(
  values["frames-only"] && values.owner
    ? pathToFileURL(path.resolve(values.owner)).href
    : "../../packages/ai/src/transports/transport-stream-shared.js"
);
const {
  createResponsesStreamWithRecovery,
}: typeof import("../../packages/ai/src/transports/openai-responses-replay-internal.js") =
  await import(
    !values["frames-only"] && values.owner
      ? pathToFileURL(path.resolve(values.owner)).href
      : "../../packages/ai/src/transports/openai-responses-replay-internal.js"
  );
const fixtureEvents = values["large-frame"]
  ? [
      {
        type: "response.output_item.done",
        item: {
          id: "msg_fixture",
          type: "message",
          content: [{ type: "output_text", text: "x".repeat(1024 * 1024) }],
        },
      },
    ]
  : Array.from({ length: eventCount }, (_, index) =>
      snapshotEvery && (index + 1) % snapshotEvery === 0
        ? {
            type: "response.output_item.done",
            item: {
              id: `msg_${index}`,
              type: "message",
              content: [{ type: "output_text", text: "x".repeat(64 * 1024) }],
            },
          }
        : {
            type:
              values.mixed && index % 2
                ? "response.function_call_arguments.delta"
                : "response.output_text.delta",
            item_id: "msg_fixture",
            output_index: 0,
            content_index: 0,
            delta: `Synthetic café 🦞 delta ${index}. `,
          },
    );
const fixture = values.fixture
  ? await readFile(values.fixture)
  : Buffer.from(
      fixtureEvents
        .map((event, index) => {
          const newline = values.mixed ? ["\n", "\r\n", "\r"][index % 3] : "\n";
          return `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
        })
        .join("") + "data: [DONE]\n\n",
    );
await writeFile(`${values.output}.sse`, fixture);
const chunks = Array.from({ length: Math.ceil(fixture.length / chunkSize) }, (_, index) =>
  fixture.subarray(index * chunkSize, (index + 1) * chunkSize),
);
const client = new OpenAI({
  apiKey: "synthetic-fixture-key",
  maxRetries: 0,
  fetch: async () => {
    let index = 0;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[index++];
            if (chunk === undefined) {
              controller.close();
            } else {
              controller.enqueue(chunk);
            }
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const model: Model<"openai-responses"> = {
  id: "fixture",
  name: "Synthetic fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://fixture.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};
const request = {
  model: "fixture",
  stream: true,
  input: [{ role: "user", content: "fixture" }],
} satisfies Parameters<typeof createResponsesStreamWithRecovery>[0]["request"];
const run = async (hash?: ReturnType<typeof createHash>) => {
  let offset = 0;
  const { stream } = values["frames-only"]
    ? {
        stream: iterateSseFrames(async () => {
          const value = chunks[offset++];
          return value === undefined ? { done: true, value: undefined } : { done: false, value };
        }),
      }
    : await createResponsesStreamWithRecovery({
        client,
        model,
        request,
        requestOptions: undefined,
        buildFullHistoryRequest: () => request,
      });
  let count = 0;
  for await (const event of stream) {
    count++;
    hash?.update(JSON.stringify(event));
  }
  return count;
};
const hash = createHash("sha256");
const eventsPerTurn = await run(hash);
assert(eventsPerTurn > 0);
const eventHash = hash.digest("hex");
for (let index = 0; index < 5; index++) {
  await run();
}
const inspector = new Session();
try {
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < turns; index++) {
    assert.equal(await run(), eventsPerTurn);
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  const events = eventsPerTurn * turns;
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  const result = {
    mode: values.mode,
    framesOnly: values["frames-only"],
    turns,
    events,
    bytes: fixture.byteLength * turns,
    chunksPerTurn: chunks.length,
    eventHash,
    fixtureHash: createHash("sha256").update(fixture).digest("hex"),
    elapsedMs,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    cpuUsPerEvent: (cpu.user + cpu.system) / events,
    sampledBytes,
    allocatedBytesPerEvent: sampledBytes === undefined ? undefined : sampledBytes / events,
    allocatedBytesPerWireByte:
      sampledBytes === undefined ? undefined : sampledBytes / (fixture.byteLength * turns),
    hostLoad,
    memory: process.memoryUsage(),
  };
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector.disconnect();
}
