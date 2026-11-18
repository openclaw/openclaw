/**
 * Measure history worker encoding, real reply transfer, and main-thread framing:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-history-activity-transfer-measure.mjs \
 *   --base-source <baseline-module.ts> [--iterations 1000] [--pairs 5] [--allocation]
 * Snapshot the baseline encoder with its relative imports resolved to that checkout.
 * Use current source as --base-source for A/A. Run timing and allocation separately.
 * Counterbalanced arms use identical 200/2000-message first/back-scroll pages.
 * This measures the response owner, not complete Gateway RPC latency or socket I/O.
 * CPU/GC/heap belong to the named thread; RSS includes both resident workers.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

function fixture(count, offset) {
  const messages = Array.from({ length: count }, (_, index) => {
    const seq = 10_000 - offset - count + index + 1;
    const id = `message-${seq}`;
    const role = ["user", "assistant", "toolResult"][index % 3];
    return {
      role,
      timestamp: 1_700_000_000_000 + seq,
      content: [
        { type: "text", text: `Synthetic history ${seq}: ${"output 漢字🦞 ".repeat(16)}` },
        ...(role === "assistant"
          ? [
              { type: "thinking", thinking: "Synthetic reasoning ".repeat(8) },
              { type: "toolCall", id: `call-${seq}`, name: "read", arguments: { path: "fixture" } },
            ]
          : []),
        ...(index % 20 === 0
          ? [{ type: "image", mimeType: "image/png", data: "YWJj".repeat(64) }]
          : []),
      ],
      __openclaw: {
        id,
        seq,
        transcriptPosition: { source: "synthetic", rawSeq: seq },
        ...(index % 20 === 0
          ? {
              attachments: [
                { id: `image-${seq}`, name: "fixture.png", mimeType: "image/png", size: 192 },
              ],
            }
          : {}),
      },
    };
  });
  return {
    messages,
    activity: messages.flatMap((message, index) =>
      index % 3 === 0
        ? []
        : [
            {
              messageId: message["__openclaw"].id,
              items: [
                {
                  itemId: `tool:${index}`,
                  toolCallId: `call-${index}`,
                  kind: "tool",
                  name: "read",
                  phase: "end",
                  status: "completed",
                  title: `Read fixture-${index}.ts`,
                  summary: "Synthetic tool result summary 漢字🦞 ".repeat(8),
                },
              ],
            },
          ],
    ),
    pagination: { offset, totalMessages: 10_000, rawPageMessages: count },
  };
}

if (!isMainThread) {
  const { encodeChatHistoryResponsePage } = await import(workerData.source);
  let page;
  let cpuStart;
  parentPort.on("message", (command) => {
    if (command.count) {
      page = fixture(command.count, command.offset);
      parentPort.postMessage({ ready: true }, []);
      return;
    }
    if (command.measure === "start") {
      cpuStart = process.threadCpuUsage();
      parentPort.postMessage({ ready: true }, []);
      return;
    }
    if (command.measure === "end") {
      const cpu = process.threadCpuUsage(cpuStart);
      parentPort.postMessage({ workerCpuUs: cpu.user + cpu.system }, []);
      return;
    }
    const encoded = encodeChatHistoryResponsePage(page, {
      encodeResponse: true,
      entry: undefined,
      maxHistoryBytes: 6 * 1024 * 1024,
      responseHistoryBytes: 512 * 1024,
    }).encodedResponse;
    const transfers = [encoded.messages, encoded.activity]
      .filter((value) => value instanceof Uint8Array)
      .map((value) => value.buffer);
    parentPort.postMessage({ encoded }, transfers);
  });
  parentPort.postMessage({ ready: true }, []);
} else {
  const { values } = parseArgs({
    options: {
      "base-source": { type: "string" },
      iterations: { type: "string", default: "1000" },
      pairs: { type: "string", default: "5" },
      allocation: { type: "boolean", default: false },
    },
  });
  assert(global.gc, "Run with --expose-gc");
  assert(values["base-source"], "Provide --base-source; current source gives A/A");
  const iterations = Number(values.iterations);
  const pairs = Number(values.pairs);
  assert(Number.isSafeInteger(iterations) && iterations > 0);
  assert(Number.isSafeInteger(pairs) && pairs > 0);
  const { SerializedJsonArray, serializeGatewayFrame } =
    await import("../../src/gateway/serialized-json.ts");
  const sources = {
    base: pathToFileURL(resolve(values["base-source"])).href,
    candidate: new URL("../../src/gateway/chat-history-response-page.ts", import.meta.url).href,
  };
  const workers = {};
  const rows = [];
  const request = async (worker, command = {}) => {
    const received = once(worker, "message");
    worker.postMessage(command, []);
    return (await received)[0];
  };
  const serialize = (encoded) => {
    const { messages, ...fields } = encoded;
    delete fields.messagesBytes;
    delete fields.responseHistoryBytes;
    delete fields.omission;
    if (fields.activity instanceof Uint8Array) {
      fields.activity = new SerializedJsonArray(fields.activity);
    }
    return serializeGatewayFrame({
      type: "res",
      id: "history",
      ok: true,
      payload: {
        messages: new SerializedJsonArray(messages),
        ...fields,
      },
    });
  };
  const sampledBytes = (node) =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
  try {
    for (const [arm, source] of Object.entries(sources)) {
      workers[arm] = new Worker(new URL(import.meta.url), {
        workerData: { source },
        execArgv: process.execArgv.filter((arg) => arg !== "--expose-gc"),
      });
      await once(workers[arm], "message");
    }
    for (const count of [200, 2000]) {
      for (const offset of [0, 4000]) {
        for (const worker of Object.values(workers)) {
          await request(worker, { count, offset });
        }
        assert.equal(
          serialize((await request(workers.base)).encoded).toString(),
          serialize((await request(workers.candidate)).encoded).toString(),
          `Wire JSON differs for ${count} messages at offset ${offset}`,
        );
        for (const worker of Object.values(workers)) {
          for (let index = 0; index < 20; index++) {
            serialize((await request(worker)).encoded);
          }
        }
        for (let pair = 0; pair < pairs; pair++) {
          for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
            global.gc();
            await setImmediate();
            const before = process.memoryUsage();
            const hostLoad = loadavg();
            const pauses = [];
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                pauses.push({ ms: entry.duration, kind: entry.detail.kind });
              }
            });
            observer.observe({ entryTypes: ["gc"] });
            const inspector = values.allocation ? new Session() : undefined;
            if (inspector) {
              inspector.connect();
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval: 32768,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            await request(workers[arm], { measure: "start" });
            const cpuStart = process.threadCpuUsage();
            const start = performance.now();
            let bytes = 0;
            for (let index = 0; index < iterations; index++) {
              const reply = await request(workers[arm]);
              bytes += serialize(reply.encoded).byteLength;
            }
            const elapsedMs = performance.now() - start;
            const cpu = process.threadCpuUsage(cpuStart);
            const { workerCpuUs } = await request(workers[arm], { measure: "end" });
            const allocatedBytes = inspector
              ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
              : undefined;
            inspector?.disconnect();
            await setImmediate();
            await setImmediate();
            observer.disconnect();
            rows.push({
              count,
              offset,
              pair: pair + 1,
              arm,
              iterations,
              hostLoad,
              bytes,
              ...(values.allocation
                ? { allocatedBytes }
                : {
                    elapsedMs,
                    mainThreadCpuUs: cpu.user + cpu.system,
                    workerCpuUs,
                    pauses,
                    memoryBefore: before,
                    memoryAfter: process.memoryUsage(),
                  }),
            });
          }
        }
      }
    }
    console.log(
      JSON.stringify(
        {
          node: process.version,
          mode: values.allocation ? "allocation" : "timing",
          byteComparisons: 4,
          rows,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(Object.values(workers).map((worker) => worker.terminate()));
  }
}
