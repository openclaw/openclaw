// Synthetic Slack/Discord text at the escape owner; no channel transport or model I/O.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/runtime-context-escape-measure.ts
// Add --allocation to sample allocations separately from uninstrumented CPU/wall time.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import {
  escapeInternalRuntimeContextDelimiters,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../src/agents/internal-runtime-context.js";

// Frozen pre-change owner, for A/A controls and interleaved A/B measurement.
function baseline(value: string): string {
  return value
    .replaceAll(INTERNAL_RUNTIME_CONTEXT_BEGIN, "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]")
    .replaceAll(INTERNAL_RUNTIME_CONTEXT_END, "[[OPENCLAW_INTERNAL_CONTEXT_END]]");
}
const allocation = process.argv.includes("--allocation");
const calls = 200_000;
const samples = 7;
const slack = {
  type: "message",
  channel: "C_SYNTHETIC",
  user: "U_SYNTHETIC",
  ts: "1793554800.000001",
  text: "<@U_SYNTHETIC> Please review <https://example.com/pull/42|the change>.\n".repeat(16),
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "Synthetic review request" } }],
  files: [{ id: "F_SYNTHETIC", name: "report.txt", mimetype: "text/plain", size: 4096 }],
};
const discord = {
  id: "100000000000000001",
  channel_id: "100000000000000002",
  author: { id: "100000000000000003", username: "synthetic", bot: false },
  content: "<@100000000000000004> Review **the change** and `sample.ts`. 🦞\n".repeat(16),
  attachments: [{ id: "100000000000000005", filename: "report.txt", size: 4096 }],
  embeds: [],
};
const workloads = {
  slack: [slack.text],
  discord: [discord.content],
  long: [slack.text.repeat(16), discord.content.repeat(16)],
  protected: [
    `${slack.text}${INTERNAL_RUNTIME_CONTEXT_BEGIN}quoted${INTERNAL_RUNTIME_CONTEXT_END}`,
    `${discord.content}${INTERNAL_RUNTIME_CONTEXT_END}`,
  ],
  delimiters: [
    `${slack.text}${INTERNAL_RUNTIME_CONTEXT_BEGIN}quoted${INTERNAL_RUNTIME_CONTEXT_END}`,
    `${discord.content}${INTERNAL_RUNTIME_CONTEXT_END}`,
    `<<<ordinary quoted syntax>>> ${slack.text}`,
  ],
};
const collect = globalThis.gc;
assert.ok(collect, "Run with --expose-gc");
assert.ok(
  Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Allocation counters require Node 26.12+",
);
const inspector = new Session();
if (allocation) {
  inspector.connect();
}
let checksum = 0;
function run(transform: (text: string) => string, texts: string[], count: number) {
  for (let index = 0; index < count; index++) {
    checksum = (checksum + transform(texts[index % texts.length]!).length) | 0;
  }
}
console.log(JSON.stringify({ node: process.version, load: loadavg(), calls, samples, allocation }));
for (const [workload, texts] of Object.entries(workloads)) {
  for (const text of texts) {
    assert.equal(escapeInternalRuntimeContextDelimiters(text), baseline(text));
  }
  run(baseline, texts, 20_000);
  run(escapeInternalRuntimeContextDelimiters, texts, 20_000);
  for (let sample = 0; sample < samples; sample++) {
    // A/A measures host drift; alternate the candidate's order across samples.
    const variants: [string, (text: string) => string][] = [
      ["A", baseline],
      ["A-control", baseline],
      ["B", escapeInternalRuntimeContextDelimiters],
    ];
    if (sample % 2) {
      variants.reverse();
    }
    for (const [variant, transform] of variants) {
      collect();
      if (allocation) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpuStart = process.cpuUsage();
      const allocatedBefore = getHeapStatistics().total_allocated_bytes;
      const start = performance.now();
      run(transform, texts, calls);
      const wallUs = ((performance.now() - start) * 1000) / calls;
      const cpu = process.cpuUsage(cpuStart);
      const allocatedBytesPerCall =
        (getHeapStatistics().total_allocated_bytes - allocatedBefore) / calls;
      let bytesPerCall: number | undefined;
      if (allocation) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        bytesPerCall = profile.samples.reduce((sum, entry) => sum + entry.size, 0) / calls;
      }
      console.log(
        JSON.stringify({
          workload,
          sample,
          variant,
          bytesPerCall,
          allocatedBytesPerCall,
          wallUs,
          cpuUs: (cpu.user + cpu.system) / calls,
        }),
      );
    }
  }
}
if (allocation) {
  inspector.disconnect();
}
assert.notEqual(checksum, 0);
