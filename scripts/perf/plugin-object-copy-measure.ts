/**
 * Channel object-copy owner benchmark (synthetic inputs, no network or Gateway).
 * Run unchanged on base/candidate, alternating order, five samples per mode:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-object-copy-measure.ts timing 3000
 * Repeat with allocation; traced CPU is diagnostic, not a timing result.
 * One operation merges 64 physical message receipts or prepares 64 topic replies.
 * Compare output digests first. Acceptance: fewer copies and lower sampled
 * allocation, with untraced CPU non-adverse; this does not measure Gateway load.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { mergeSlackSendResults } from "../../extensions/slack/src/send-results.js";
import { buildTelegramThreadReplyParams } from "../../extensions/telegram/src/reply-parameters.js";

const mode = process.argv[2] ?? "timing";
const iterations = Number(process.argv[3] ?? 3000);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
const results = Array.from({ length: 16 }, (_, i) => ({
  channelId: "synthetic-channel",
  messageId: `message-${i}`,
  receipt: {
    platformMessageIds: Array.from({ length: 4 }, (_value, j) => `message-${i}-${j}`),
    parts: Array.from({ length: 4 }, (_value, j) => ({
      platformMessageId: `message-${i}-${j}`,
      kind: "text" as const,
      index: j,
      threadId: "synthetic-thread",
    })),
    sentAt: 1,
    threadId: "synthetic-thread",
  },
}));
const replies = Array.from({ length: 64 }, (_, i) => ({
  thread: { id: i + 2, scope: "forum" as const },
  replyToMessageId: i + 100,
}));
let output: unknown;
const workloads = [
  { name: "slack-64-receipt-parts", run: () => (output = mergeSlackSendResults(results)) },
  {
    name: "telegram-64-topic-replies",
    run: () => (output = replies.map((reply) => buildTelegramThreadReplyParams(reply))),
  },
];
const digest = () => createHash("sha256").update(JSON.stringify(output)).digest("hex");
for (const workload of workloads) {
  workload.run();
  const outputSha256 = digest();
  for (let i = 0; i < iterations; i++) {
    workload.run();
  }
  global.gc?.();
  const inspector = new Session();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const start = process.threadCpuUsage();
  const wallStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    workload.run();
  }
  const wallMs = performance.now() - wallStart;
  const cpu = process.threadCpuUsage(start);
  let allocatedBytes: number | undefined;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  assert.equal(digest(), outputSha256);
  console.log(
    JSON.stringify({
      workload: workload.name,
      mode,
      iterations,
      outputSha256,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      wallMs,
      allocatedBytes,
      bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      hostLoad,
      memory: process.memoryUsage(),
    }),
  );
}
