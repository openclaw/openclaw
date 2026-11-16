/**
 * Payload policy cost on an active 2,000-item synthetic session; no DB/filesystem reads.
 * Save the exact baseline beside openai-responses-payload-policy.ts, then run:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-compaction-storage-measure.ts <baseline-path>
 * Five A/A controls and five interleaved A/B pairs; timing and allocation sampled separately.
 * Acceptance: no input mutation, bounded active-input scan, <10us added CPU/request.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as candidate from "../../packages/ai/src/transports/openai-responses-payload-policy.js";

assert(process.argv[2], "Provide the exact original module beside its owner");
assert(globalThis.gc, "Use --expose-gc");
const baseline: typeof candidate = await import(pathToFileURL(resolve(process.argv[2])).href);
const model = { api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1" };
const rounds = 100_000;
const original = Array.from({ length: 2_000 }, (_, index) =>
  Object.freeze({
    type: "message",
    role: index % 2 ? "assistant" : "user",
    id: `msg_${index}`,
    content: [{ type: "input_text", text: "Synthetic history ".repeat(128) }],
  }),
);
const compacted = [
  ...original.slice(0, 36),
  Object.freeze({
    type: "compaction",
    id: "cmp_synthetic",
    encrypted_content: "synthetic checkpoint".repeat(4096),
  }),
  ...original.slice(36),
];
const inspector = new Session();
inspector.connect();
const measure = async (owner: typeof candidate, input: unknown[], allocation: boolean) => {
  const policy = owner.resolveOpenAIResponsesPayloadPolicy(model);
  const payload = { input, store: true };
  for (let index = 0; index < 10_000; index++) {
    owner.applyOpenAIResponsesPayloadPolicy(payload, policy);
  }
  globalThis.gc?.();
  if (allocation) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < rounds; index++) {
    owner.applyOpenAIResponsesPayloadPolicy(payload, policy);
  }
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const profile = allocation
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  return {
    wallUs: (elapsed * 1000) / rounds,
    cpuUs: (used.user + used.system) / rounds,
    sampledBytesPerRequest: profile
      ? profile.samples.reduce((sum, sample) => sum + sample.size, 0) / rounds
      : undefined,
    store: payload.store,
  };
};
try {
  console.log(
    JSON.stringify({
      load: loadavg(),
      rounds,
      ordinaryItems: original.length,
      compactedItems: compacted.length,
    }),
  );
  for (const [shape, input] of [
    ["ordinary", original],
    ["compacted", compacted],
  ] as const) {
    const before = JSON.stringify(input);
    for (const allocation of [false, true]) {
      for (let pair = 0; pair < 5; pair++) {
        const order: Array<[string, typeof candidate]> = [
          ["control-a", baseline],
          ["control-a2", baseline],
          [pair % 2 ? "candidate" : "baseline", pair % 2 ? candidate : baseline],
          [pair % 2 ? "baseline" : "candidate", pair % 2 ? baseline : candidate],
        ];
        for (const [label, owner] of order) {
          console.log(
            JSON.stringify({
              shape,
              allocation,
              pair,
              label,
              ...(await measure(owner, input, allocation)),
            }),
          );
        }
      }
    }
    assert.equal(JSON.stringify(input), before);
  }
} finally {
  inspector.disconnect();
}
