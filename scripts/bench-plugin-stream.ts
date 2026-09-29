// Run with node --expose-gc --import ./scripts/tsx.mjs scripts/bench-plugin-stream.ts.
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { PluginInstance } from "../src/plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { createPluginRecord } from "../src/plugins/status.test-helpers.js";

const events = 2_000;
const registry = createEmptyPluginRegistry();
const record = createPluginRecord({ id: "stream-fixture", origin: "bundled" });
registry.plugins.push(record);
const instance = new PluginInstance(record.id, { record, registry });
const content = Array.from({ length: 64 }, () => ({ type: "text", text: "x".repeat(38) }));
const payload = { type: "text_delta", delta: "chunk", partial: { content } };
const toolResult = {
  type: "tool_result",
  content: Array.from({ length: 50 }, () =>
    content.map((block) => ({ type: block.type, text: block.text })),
  ),
};
const provider = instance.wrap({
  async *stream() {
    for (let sequence = 0; sequence < events; sequence++) {
      yield { ...payload, sequence };
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
  for (const layers of [0, 5]) {
    await consume(layers);
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      await consume(layers);
      samples.push((performance.now() - start) / (events + 1));
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
    const nodes = [profile.head];
    let bytes = 0;
    for (const node of nodes) {
      bytes += node.selfSize;
      nodes.push(...node.children);
    }
    console.log(
      JSON.stringify({
        node: process.version,
        events,
        layers,
        eventBytes: Buffer.byteLength(JSON.stringify(payload)),
        toolResultBytes: Buffer.byteLength(JSON.stringify(toolResult)),
        msPerEvent: samples.toSorted((a, b) => a - b)[2],
        sampledAllocatedBytesPerEvent: bytes / (events + 1),
        rssBytes: process.memoryUsage().rss,
      }),
    );
  }
} finally {
  await instance.dispose();
}
