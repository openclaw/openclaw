/**
 * Provider-bound context pressure on a synthetic 1M-window, tool-heavy session.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/context-pressure-measure.ts \
 *   --base-owner .local/base-preemptive-compaction.ts \
 *   --base-estimator .local/base-context-token-pressure.ts --mode timing
 * Repeat with --mode allocation; add --control for an A/A baseline control.
 * Use --pending prose|dense to compare ordinary text and punctuation-heavy JSON.
 * Five alternating samples per arm, warm CPU/wall and sampled allocations.
 * This owner reads the prepared request only: no session DB or workspace traversal.
 * Acceptance: bounded tail pricing, no material CPU increase. Occupancy changes
 * are reported separately when the estimator calibration itself changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { Message } from "@openclaw/llm-core";

const { values } = parseArgs({
  options: {
    "base-owner": { type: "string" },
    "base-estimator": { type: "string" },
    control: { type: "boolean", default: false },
    pending: { type: "string", default: "prose" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
  },
});
const iterations = Number(values.iterations);
const samples = Number(values.samples);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(["timing", "allocation"].includes(values.mode));
assert(["prose", "dense"].includes(values.pending));
const gc = global.gc;
assert(gc, "use --expose-gc");
const ownerUrl = new URL(
  "../../src/agents/embedded-agent-runner/run/preemptive-compaction.ts",
  import.meta.url,
).href;
const estimatorUrl = new URL("../../src/agents/sessions/context-token-pressure.ts", import.meta.url)
  .href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url.split("?")[0] !== ownerUrl && url !== `${estimatorUrl}?base`) {
      return next(url, context);
    }
    const isBase = url.endsWith("?base") || values.control;
    const source = readFileSync(
      url === `${estimatorUrl}?base`
        ? (values["base-estimator"] ?? new URL(estimatorUrl))
        : isBase && values["base-owner"]
          ? values["base-owner"]
          : new URL(ownerUrl),
      "utf8",
    );
    return {
      format: "module",
      source: stripTypeScriptTypes(
        isBase && url.startsWith(ownerUrl)
          ? source.replace(
              '"../../sessions/context-token-pressure.js"',
              JSON.stringify(`${estimatorUrl}?base`),
            )
          : source,
      ),
      shortCircuit: true,
    };
  },
});
type Owner = typeof import("../../src/agents/embedded-agent-runner/run/preemptive-compaction.js");
const base: Owner = await import(`${ownerUrl}?base`);
const candidate: Owner = await import(`${ownerUrl}?candidate`);
hooks.deregister();
const messages: Message[] = [];
function assistant(round: number): Message {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "synthetic",
    model: "synthetic",
    content: [
      {
        type: "toolCall",
        id: `read-${round}`,
        name: "read",
        arguments: { path: `src/file-${round}.ts` },
      },
    ],
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    responseId: `response-${round}`,
    stopReason: "toolUse",
    timestamp: round,
  };
}
for (let round = 0; round < 240; round++) {
  messages.push(
    { role: "user", content: `Inspect source file ${round}.`, timestamp: round },
    assistant(round),
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: `read-${round}`,
      content: [
        {
          type: "text",
          text: `// source file ${round}\n${"const result = inspect(input);\n".repeat(550)}`,
        },
      ],
      isError: false,
      timestamp: round,
    },
  );
}
const messageCount = messages.length;
messages.push(assistant(999));
messages.push({
  role: "toolResult",
  toolName: "read",
  toolCallId: "read-999",
  content: [
    {
      type: "text",
      text: (values.pending === "dense"
        ? '{"id":123,"ok":false,"path":"src/a.ts","value":[1,2,3]}\n'.repeat(1300)
        : "Pending source evidence.\n".repeat(2600)
      ).slice(0, 65_000),
    },
  ],
  isError: false,
  timestamp: 999,
});
const request: Parameters<Owner["resolveProjectedRequestPressure"]>[0] = {
  context: {
    messages,
    systemPrompt: "Inspect the repository and explain the change.",
    tools: [{ name: "read", description: "Read a source file", parameters: { type: "object" } }],
  },
  previousRequest: {
    requestIndex: 240,
    messageCount,
    contextTokens: 650_000,
    responseId: "response-999",
  },
  contextTokenBudget: 1_000_000,
  reserveTokens: 20_000,
};
const fixtureBytes = Buffer.byteLength(JSON.stringify(request));
for (let sample = 0; sample < samples; sample++) {
  const arms: Array<readonly [string, Owner]> = [
    ["base", base],
    ["candidate", candidate],
  ];
  for (const [arm, owner] of sample % 2 === 0 ? arms : arms.toReversed()) {
    const expectedTokens = owner.resolveProjectedRequestPressure(request).estimatedPromptTokens;
    for (let index = 0; index < 100; index++) {
      owner.resolveProjectedRequestPressure(request);
    }
    gc();
    const inspector = new Session();
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const durations: number[] = [];
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    let total = 0;
    for (let index = 0; index < iterations; index++) {
      const before = performance.now();
      total += owner.resolveProjectedRequestPressure(request).estimatedPromptTokens;
      durations.push(performance.now() - before);
    }
    const wallMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    let allocatedBytes: number | undefined;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((value, child) => value + sum(child), 0);
      allocatedBytes = sum(profile.head);
      inspector.disconnect();
    }
    assert.equal(total, expectedTokens * iterations);
    durations.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        arm,
        sample: sample + 1,
        mode: values.mode,
        pending: values.pending,
        iterations,
        fixtureBytes,
        historyMessages: messageCount,
        pendingMessages: messages.length - messageCount,
        projectedTokens: expectedTokens,
        windowTokens: request.contextTokenBudget,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        p50Ms: durations[Math.floor(durations.length * 0.5)],
        p95Ms: durations[Math.floor(durations.length * 0.95)],
        allocatedBytes,
        bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        hostLoad: loadavg(),
      }),
    );
  }
}
