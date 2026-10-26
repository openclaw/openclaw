/**
 * Real OpenAI transport + SDK against synthetic loopback SSE (300 deltas/turn).
 * node --import ./scripts/tsx.mjs scripts/perf/openai-sdk-stream-measure.ts
 *   --api completions --turns 20 --mode allocation --output .local/openai-stream.json
 * Run timing and allocation separately, alternating already-prepared base/candidate
 * checkouts. --owner accepts an alternate completions transport module in the same
 * source tree. Allocation profiles retain dependency frames; no provider credentials.
 * Requests and events are hashed outside measurement (only timestamps normalized).
 * For network-free replay, pass --api responses --fixture <recorded.sse>.
 * Each run records its synthetic wire fixture at <output>.sse for later replay.
 * The recording must use this script's text/reasoning/lookup fixture contract;
 * replay splits its bytes into 1 KiB chunks before starting measurement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { createOpenAIResponsesTransportStreamFn } from "../../packages/ai/src/transports/openai-responses-client.js";
import type { Model } from "../../packages/ai/src/types.js";

const { values } = parseArgs({
  options: {
    api: { type: "string", default: "completions" },
    turns: { type: "string", default: "20" },
    warmup: { type: "string", default: "10" },
    mode: { type: "string", default: "timing" },
    owner: { type: "string" },
    output: { type: "string" },
    fixture: { type: "string" },
  },
});
assert(values.api === "completions" || values.api === "responses");
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.output, "--output is required");
const turns = Number(values.turns);
assert(Number.isSafeInteger(turns) && turns > 0);
const warmup = Number(values.warmup);
assert(Number.isSafeInteger(warmup) && warmup >= 0);
const {
  createOpenAICompletionsTransportStreamFn,
}: typeof import("../../packages/ai/src/transports/openai-completions-transport.js") = await import(
  values.owner
    ? pathToFileURL(path.resolve(values.owner)).href
    : "../../packages/ai/src/transports/openai-completions-transport.js"
);
const delta = "A synthetic streaming delta café 🦞. ";
const count = 100;
const text = delta.repeat(count);
const argsParts = ['{"query":"', ...Array.from({ length: count - 2 }, () => "synthetic "), '"}'];
const args = argsParts.join("");
const events: Record<string, unknown>[] = [];
if (values.api === "responses") {
  const reasoning = { id: "rs_fixture", type: "reasoning", summary: [] };
  const message = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  const tool = {
    id: "fc_fixture",
    call_id: "call_fixture",
    type: "function_call",
    name: "lookup",
    arguments: "",
  };
  const add = (item: object, index: number) =>
    events.push({ type: "response.output_item.added", output_index: index, item });
  const done = (item: object, index: number) =>
    events.push({ type: "response.output_item.done", output_index: index, item });
  add(reasoning, 0);
  events.push({
    type: "response.reasoning_summary_part.added",
    item_id: reasoning.id,
    output_index: 0,
    summary_index: 0,
    part: { type: "summary_text", text: "" },
  });
  for (let i = 0; i < count; i++) {
    events.push({
      type: "response.reasoning_summary_text.delta",
      item_id: reasoning.id,
      output_index: 0,
      summary_index: 0,
      delta,
    });
  }
  const finalReasoning = { ...reasoning, summary: [{ type: "summary_text", text }] };
  done(finalReasoning, 0);
  add(message, 1);
  events.push({
    type: "response.content_part.added",
    item_id: message.id,
    output_index: 1,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  for (let i = 0; i < count; i++) {
    events.push({
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 1,
      content_index: 0,
      delta,
    });
  }
  const finalMessage = {
    ...message,
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  done(finalMessage, 1);
  add(tool, 2);
  for (const argumentDelta of argsParts) {
    events.push({
      type: "response.function_call_arguments.delta",
      item_id: tool.id,
      output_index: 2,
      delta: argumentDelta,
    });
  }
  const finalTool = { ...tool, arguments: args, status: "completed" };
  done(finalTool, 2);
  events.push({
    type: "response.completed",
    response: {
      id: "resp_fixture",
      status: "completed",
      output: [finalReasoning, finalMessage, finalTool],
      usage: { input_tokens: 100, output_tokens: 300, total_tokens: 400 },
    },
  });
} else {
  const chunk = (contentDelta: object, finish_reason: string | null = null) => ({
    id: "chat_fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta: contentDelta, finish_reason }],
  });
  for (let i = 0; i < count; i++) {
    events.push(chunk({ reasoning_content: delta }));
  }
  for (let i = 0; i < count; i++) {
    events.push(chunk({ content: delta }));
  }
  for (const [i, argumentsPart] of argsParts.entries()) {
    events.push(
      chunk({
        tool_calls: [
          {
            index: 0,
            ...(i === 0 ? { id: "call_fixture", type: "function" } : {}),
            function: { ...(i === 0 ? { name: "lookup" } : {}), arguments: argumentsPart },
          },
        ],
      }),
    );
  }
  events.push(chunk({}, "tool_calls"));
}
const frames = events.map((event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
frames.push(Buffer.from("data: [DONE]\n\n"));
let capturedRequest = "";
let capture = false;
let requests = 0;
const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    if (capture) {
      capturedRequest = body;
    }
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    void (async () => {
      for (const [i, frame] of frames.entries()) {
        res.write(frame);
        // Keep wire chunks realistic instead of handing the SDK one prebuilt body.
        if (i % 8 === 7) {
          await setImmediate();
        }
      }
      res.end();
    })();
  });
});
const replay = values.fixture ? await readFile(values.fixture) : undefined;
await writeFile(`${values.output}.sse`, replay ?? Buffer.concat(frames));
if (replay) {
  const chunks = Array.from({ length: Math.ceil(replay.length / 1024) }, (_, index) =>
    replay.subarray(index * 1024, (index + 1) * 1024),
  );
  configureAiTransportHost({
    buildModelFetch: () => async (_input, init) => {
      if (capture) {
        capturedRequest = await new Response(init?.body).text();
      }
      requests++;
      let index = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const chunk = chunks[index++];
              if (chunk !== undefined) {
                controller.enqueue(chunk);
              } else {
                controller.close();
              }
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}
// Explicit loopback port range; fixture replay never opens a socket.
if (!replay) {
  for (let port = 41000; ; port++) {
    try {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      break;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EADDRINUSE") ||
        port >= 41999
      ) {
        throw error;
      }
    }
  }
}
const address = server.address();
assert(replay || (address && typeof address !== "string"));
const model: Model = {
  id: "fixture",
  name: "Synthetic fixture",
  provider: "openai",
  api: values.api === "responses" ? "openai-responses" : "openai-completions",
  baseUrl: replay
    ? "https://fixture.invalid/v1"
    : `http://127.0.0.1:${address && typeof address !== "string" ? address.port : 41000}/v1`,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};
const stream =
  values.api === "responses"
    ? createOpenAIResponsesTransportStreamFn()
    : createOpenAICompletionsTransportStreamFn();
const context = {
  messages: [{ role: "user" as const, content: "Run a synthetic lookup.", timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Synthetic lookup",
      parameters: {
        type: "object" as const,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
};
let eventCount = 0;
const run = async (hash?: ReturnType<typeof createHash>) => {
  const result = await stream(model, context, {
    apiKey: "synthetic-fixture-key",
    transport: "sse",
  });
  let terminal = false;
  for await (const event of result) {
    eventCount++;
    hash?.update(JSON.stringify(event, (key, value: unknown) => (key === "timestamp" ? 0 : value)));
    if (event.type === "error") {
      throw new Error(event.error.errorMessage);
    }
    if (event.type === "done") {
      terminal = true;
      assert.equal(event.message.stopReason, "toolUse");
      const tool = event.message.content.find((part) => part.type === "toolCall");
      assert(tool?.type === "toolCall");
      assert.deepEqual(tool.arguments, JSON.parse(args));
    }
  }
  assert(terminal);
};
const inspector = new Session();
try {
  capture = true;
  const hash = createHash("sha256");
  await run(hash);
  capture = false;
  const eventHash = hash.digest("hex");
  const requestHash = createHash("sha256").update(capturedRequest).digest("hex");
  for (let i = 0; i < warmup; i++) {
    await run();
  }
  eventCount = 0;
  requests = 0;
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpuStart = process.cpuUsage();
  const threadStart = process.threadCpuUsage();
  const start = performance.now();
  for (let i = 0; i < turns; i++) {
    await run();
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const thread = process.threadCpuUsage(threadStart);
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    await writeFile(`${values.output}.heapprofile`, JSON.stringify(profile));
  }
  const result = {
    api: values.api,
    mode: values.mode,
    turns,
    warmup,
    deltas: turns * count * 3,
    requests,
    eventCount,
    requestHash,
    eventHash,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuMsPer1000Deltas: (cpu.user + cpu.system) / (turns * count * 3),
    mainThreadCpuMsPer1000Deltas: (thread.user + thread.system) / (turns * count * 3),
    sampledBytes,
    sampledBytesPer1000Deltas:
      sampledBytes === undefined ? undefined : (sampledBytes * 1000) / (turns * count * 3),
    hostLoad,
    memory: process.memoryUsage(),
  };
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector.disconnect();
  if (!replay) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
