/**
 * Synthetic history sanitizer owner probe (no Gateway/SQL/network).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-history-tool-text-measure.mjs \
 *   --base-source <unchanged-sanitizer.ts> --iterations 1000 --pairs 5 [--allocation]
 * Snapshot baseline source with relative imports resolved to this checkout; use current
 * source for A/A. Counterbalanced arms compare 200-message pages with 65 nested tool
 * results, each below the native producer's 32 KiB bound. Timing is untraced; allocation
 * is a separate pass including collected objects. Both sanitizer passes used by history
 * are measured; read/admission, worker transfer and final JSON encoding are excluded.
 * Acceptance: identical output/input bytes and lower CPU or allocation per page.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sanitizeChatHistoryMessages } from "../../src/gateway/chat-display-projection.sanitize.ts";

const { values } = parseArgs({
  options: {
    "base-source": { type: "string" },
    iterations: { type: "string", default: "1000" },
    pairs: { type: "string", default: "5" },
    allocation: { type: "boolean", default: false },
  },
});
assert(globalThis.gc && values["base-source"], "Use --expose-gc and --base-source");
const iterations = Number(values.iterations);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
const arms = {
  base: (await import(pathToFileURL(resolve(values["base-source"])).href))
    .sanitizeChatHistoryMessages,
  candidate: sanitizeChatHistoryMessages,
};
const messages = Array.from({ length: 200 }, (_, index) =>
  index < 65
    ? {
        role: "custom",
        display: true,
        content: [
          {
            type: "toolResult",
            toolCallId: `tool-${index}`,
            toolName: "read",
            content: Array.from({ length: 4 }, (_unused, block) => ({
              type: "text",
              text: `Synthetic output ${index}/${block}: ${"x".repeat(4000)}`,
            })),
          },
        ],
      }
    : {
        role: index % 2 ? "assistant" : "user",
        content: [{ type: "text", text: "Synthetic reply" }],
      },
);
const input = JSON.stringify(messages);
const options = { toolResultMaxChars: 2000 };
const project = (owner) => owner(owner(messages, Number.MAX_SAFE_INTEGER), 8000, options);
const expected = JSON.stringify(project(arms.base));
assert.equal(JSON.stringify(project(arms.candidate)), expected);
assert.equal(JSON.stringify(messages), input);
const rows = [];
for (const owner of Object.values(arms)) {
  for (let index = 0; index < 100; index++) {
    project(owner);
  }
}
for (let pair = 0; pair < pairs; pair++) {
  for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
    globalThis.gc();
    await setImmediate();
    const inspector = values.allocation ? new Session() : undefined;
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const cpuStart = process.threadCpuUsage();
    const start = performance.now();
    let result;
    for (let index = 0; index < iterations; index++) {
      result = project(arms[arm]);
    }
    const elapsedMs = performance.now() - start;
    const cpu = process.threadCpuUsage(cpuStart);
    const sampledBytes = inspector
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, item) => sum + item.size,
          0,
        )
      : undefined;
    inspector?.disconnect();
    assert.equal(JSON.stringify(result), expected);
    rows.push({
      pair,
      arm,
      iterations,
      hostLoad,
      ...(values.allocation
        ? { sampledBytesPerPage: sampledBytes / iterations }
        : {
            cpuUsPerPage: (cpu.user + cpu.system) / iterations,
            wallMsPerPage: elapsedMs / iterations,
          }),
    });
  }
}
assert.equal(JSON.stringify(messages), input);
console.log(
  JSON.stringify(
    {
      node: process.version,
      mode: values.allocation ? "allocation" : "timing",
      messages: messages.length,
      nestedResults: 65,
      inputBytes: Buffer.byteLength(input),
      outputBytes: Buffer.byteLength(expected),
      rows,
    },
    null,
    2,
  ),
);
