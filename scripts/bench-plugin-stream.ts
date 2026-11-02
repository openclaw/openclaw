// Run with node --expose-gc --import ./scripts/tsx.mjs scripts/bench-plugin-stream.ts.
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { PluginInstance } from "../src/plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { createPluginRecord } from "../src/plugins/status.test-helpers.js";

const events = 2_000;
const workload = process.argv[2] ?? "text";
if (workload !== "text" && workload !== "mixed") {
  throw new Error("Expected text or mixed workload");
}
const registry = createEmptyPluginRegistry();
const record = createPluginRecord({ id: "stream-fixture", origin: "bundled" });
registry.plugins.push(record);
const instance = new PluginInstance(record.id, { record, registry });
const content = Array.from({ length: 64 }, () => ({ type: "text", text: "x".repeat(38) }));
const payload = { type: "text_delta", delta: "chunk", partial: { content } };
const longText = {
  ...payload,
  partial: { content: [...content, { type: "text", text: "assistant text ".repeat(2_000) }] },
};
const toolCall = {
  type: "toolcall_delta",
  delta: '"argument":',
  partial: {
    content: [
      {
        type: "toolCall",
        id: "call_fixture",
        name: "read",
        arguments: { text: "x".repeat(8_000) },
      },
    ],
  },
};
const toolResult = {
  type: "tool_result",
  content: Array.from({ length: 50 }, () =>
    content.map((block) => ({ type: block.type, text: block.text })),
  ),
};
const provider = instance.wrap({
  async *stream() {
    for (let sequence = 0; sequence < events; sequence++) {
      const event =
        workload === "text"
          ? payload
          : sequence % 100 === 99
            ? toolResult
            : sequence % 5 === 4
              ? toolCall
              : longText;
      yield { ...event, sequence };
    }
    yield toolResult;
  },
});
function transform(source: AsyncIterable<unknown>): AsyncIterable<unknown> {
  return instance.wrap({
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => iterator.return?.() ?? { done: true, value: undefined },
      };
    },
  });
}
async function consume(layers: number) {
  let source: AsyncIterable<unknown> = provider.stream();
  for (let layer = 0; layer < layers; layer++) {
    source = transform(source);
  }
  let count = 0;
  for await (const _ of source) {
    count++;
  }
  if (count !== events + 1) {
    throw new Error(`Lost events: ${count}`);
  }
}

try {
  for (const layers of [0, 1, 5]) {
    await consume(layers);
    const samples: number[] = [];
    const cpuSamples: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      const cpu = process.threadCpuUsage();
      await consume(layers);
      samples.push((performance.now() - start) / (events + 1));
      const used = process.threadCpuUsage(cpu);
      cpuSamples.push((used.user + used.system) / 1_000 / (events + 1));
    }
    globalThis.gc?.();
    const session = new Session();
    session.connect();
    await session.post("HeapProfiler.startSampling", {
      samplingInterval: 512,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await consume(layers);
    const { profile } = await session.post("HeapProfiler.stopSampling");
    session.disconnect();
    const nodes = [{ node: profile.head, category: "other" }];
    const categories: Record<string, number> = {};
    let bytes = 0;
    for (const entry of nodes) {
      const { node } = entry;
      const name = node.callFrame.functionName;
      const category =
        name === "isPluginData"
          ? "dataWalk"
          : entry.category === "dataWalk"
            ? entry.category
            : name === "structuredClone"
              ? "structuredClone"
              : name === "wrap"
                ? "valueViews"
                : name === "wrapIteratorResult" || name === "IteratorResultReader"
                  ? "iteratorResults"
                  : name === "readResultMember"
                    ? "resultReads"
                    : entry.category;
      bytes += node.selfSize;
      categories[category] = (categories[category] ?? 0) + node.selfSize;
      nodes.push(...node.children.map((child) => ({ node: child, category })));
    }
    console.log(
      JSON.stringify({
        node: process.version,
        events,
        workload,
        layers,
        eventBytes: Buffer.byteLength(JSON.stringify(payload)),
        toolResultBytes: Buffer.byteLength(JSON.stringify(toolResult)),
        msPerEvent: samples.toSorted((a, b) => a - b)[2],
        mainThreadMsPer10kEvents: cpuSamples.toSorted((a, b) => a - b)[2]! * 10_000,
        sampledAllocatedBytesPerEvent: bytes / (events + 1),
        sampledMBPer10kEvents: bytes / (events + 1) / 100,
        allocationCategories: Object.fromEntries(
          Object.entries(categories).map(([name, size]) => [
            name,
            { bytesPerEvent: size / (events + 1), percent: (100 * size) / bytes },
          ]),
        ),
        rssBytes: process.memoryUsage().rss,
      }),
    );
  }
} finally {
  await instance.dispose();
}
