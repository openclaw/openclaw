/**
 * Compare response budgeting on two source revisions (not end-to-end RPC latency):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-history-response-page-measure.mjs \
 *   --base-source <baseline-module.ts> [--iterations 400] [--pairs 5] [--allocation]
 * The baseline module must export prepareChatHistoryResponsePage with its own budget owner.
 * Use an unchanged source snapshot with relative imports resolved to its checkout.
 * Run timing and allocation separately; --reverse counterbalances the initial arm.
 * An unchanged source is an A/A control only without --fullness, which compares
 * two different operations even when both modules come from the same revision.
 * Pages contain text, tool calls/results, images, activity, and transcript positions.
 * Before timing, compare full JSON responses for fit/tail/anchor/oversized cases.
 * Add --encode to include worker response encoding; --messages 300 --text-repeats 512
 * models repeated large-tool-result pages. Allocation is sampled separately from CPU.
 * Use --response-bytes 524288 for the transport page cap (default: 6 MiB).
 * Use --fullness to compare the discarded full-response budget check with the
 * candidate selection-only predicate. This measures the owner check, not RPC latency.
 * Example: --fullness --messages 600 --text-repeats 120 --response-bytes 524288
 *   --iterations 500 --pairs 2 (repeat with --allocation for sampled allocation).
 * Accept only equivalent responses/fullness decisions with lower CPU or allocation;
 * report absolute GC deltas separately and use matched controls before alleging harm.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as candidate from "../../src/gateway/chat-history-response-page.ts";

const { values } = parseArgs({
  options: {
    "base-source": { type: "string" },
    iterations: { type: "string", default: "400" },
    pairs: { type: "string", default: "5" },
    allocation: { type: "boolean", default: false },
    reverse: { type: "boolean", default: false },
    encode: { type: "boolean", default: false },
    fullness: { type: "boolean", default: false },
    messages: { type: "string" },
    "text-repeats": { type: "string", default: "64" },
    "response-bytes": { type: "string", default: String(6 * 1024 * 1024) },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(values["base-source"], "Provide --base-source");
const iterations = Number(values.iterations);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(!(values.encode && values.fullness), "Choose either --encode or --fullness");
const method = values.encode ? "encodeChatHistoryResponsePage" : "prepareChatHistoryResponsePage";
const base = await import(pathToFileURL(resolve(values["base-source"])).href);
const arms = values.fullness
  ? {
      base: (page, options) =>
        base.prepareChatHistoryResponsePage(page, options).omission?.byteLimited === true,
      candidate: candidate.isChatHistoryResponsePageByteLimited,
    }
  : { base: base[method], candidate: candidate[method] };
const params = {
  entry: undefined,
  maxHistoryBytes: 6 * 1024 * 1024,
  responseHistoryBytes: Number(values["response-bytes"]),
  encodeResponse: true,
};
const fixtures = (values.messages ? [Number(values.messages)] : [200, 2000]).map((count) => {
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index % 3 === 0 ? "user" : index % 3 === 1 ? "assistant" : "toolResult",
    timestamp: 1_700_000_000_000 + index,
    content: [
      {
        type: "text",
        text: `Synthetic history ${index}: ${"output 🦞 ".repeat(Number(values["text-repeats"]))}`,
      },
      ...(index % 3 === 1
        ? [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: "fixture" } }]
        : []),
      ...(index % 20 === 0
        ? [{ type: "image", mimeType: "image/png", data: "YWJj".repeat(1024) }]
        : []),
    ],
    __openclaw: {
      id: `message-${index}`,
      seq: index + 1,
      transcriptPosition: {
        source: "synthetic",
        rawSeq: index + 1,
        ...(values.fullness && index % 3 === 2
          ? {
              activity: {
                afterRawSeq: index - 1,
                scopeId: `scope-${Math.floor(index / 30)}`,
                startOrder: index % 30,
              },
            }
          : {}),
      },
    },
  }));
  return {
    messages,
    activity: messages.flatMap((message, index) =>
      index % 3 === 2 ? [{ messageId: message["__openclaw"].id, items: [] }] : [],
    ),
    pagination: { offset: 0, totalMessages: count, rawPageMessages: count },
  };
});
let byteComparisons = 0;
for (const fixture of fixtures) {
  const oversized = structuredClone(fixture);
  for (const index of [0, 1, 2, fixture.messages.length - 1]) {
    oversized.messages[index].content = [{ type: "text", text: "x".repeat(150_000) }];
  }
  oversized.messages[1]["__openclaw"].seq = oversized.messages[2]["__openclaw"].seq = 1;
  for (const page of [fixture, oversized]) {
    const inputBytes = JSON.stringify(page);
    for (const responseHistoryBytes of [512 * 1024, 6 * 1024 * 1024]) {
      for (const messageId of [undefined, "message-1"]) {
        const options = { ...params, responseHistoryBytes, messageId };
        assert.equal(
          JSON.stringify(candidate[method](page, options)),
          JSON.stringify(base[method](page, options)),
        );
        if (values.fullness) {
          const full = arms.candidate(page, options);
          assert.equal(typeof full, "boolean");
          assert.equal(full, arms.base(page, options));
        }
        assert.equal(JSON.stringify(page), inputBytes);
        byteComparisons++;
      }
    }
  }
}
function sampledBytes(node) {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const rows = [];
for (const fixture of fixtures) {
  for (const prepare of Object.values(arms)) {
    for (let index = 0; index < 50; index++) {
      prepare(fixture, params);
    }
  }
  for (let pair = 0; pair < pairs; pair++) {
    const order =
      (pair + Number(values.reverse)) % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
    for (const arm of order) {
      global.gc();
      await setImmediate();
      const hostLoad = loadavg();
      const pauses = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          pauses.push({ ms: entry.duration, kind: entry.detail.kind });
        }
      });
      observer.observe({ entryTypes: ["gc"] });
      let inspector;
      if (values.allocation) {
        inspector = new Session();
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpuStart = process.threadCpuUsage();
      const start = performance.now();
      let bytes = 0;
      let fullPages = 0;
      for (let index = 0; index < iterations; index++) {
        const result = arms[arm](fixture, params);
        if (values.fullness) {
          fullPages += Number(result);
        } else {
          bytes += values.encode
            ? result.encodedResponse.messages.byteLength
            : result.messagesBytes;
        }
      }
      const elapsedMs = performance.now() - start;
      const cpu = process.threadCpuUsage(cpuStart);
      let allocatedBytes;
      if (inspector) {
        allocatedBytes = sampledBytes(
          (await inspector.post("HeapProfiler.stopSampling")).profile.head,
        );
        inspector.disconnect();
      }
      await setImmediate();
      await setImmediate();
      observer.disconnect();
      rows.push({
        messages: fixture.messages.length,
        pair: pair + 1,
        arm,
        iterations,
        hostLoad,
        ...(values.fullness ? { fullPages } : { bytes }),
        ...(values.allocation
          ? { allocatedBytes }
          : {
              elapsedMs,
              threadCpuUs: cpu.user + cpu.system,
              pauses,
            }),
      });
    }
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      responseHistoryBytes: params.responseHistoryBytes,
      mode: values.allocation ? "allocation" : "timing",
      operation: values.fullness ? "fullness" : method,
      byteComparisons,
      rows,
    },
    null,
    2,
  ),
);
