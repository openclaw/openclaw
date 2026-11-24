/**
 * Synthetic mixed CJK/Latin paragraph replay through handleMessageUpdate and the real
 * directive/rendering owners. No Gateway, provider, database, or network is involved.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/assistant-text-update-measure.ts \
 *   --mode verify --output .local/text-update-golden.json
 * Repeat with --mode timing or allocation; run baseline/candidate serially in ABAB order.
 * --mode counts separately counts paragraph-scanner calls and input characters.
 * --cadence 10 simulates 100 deltas/s against commentary's 75ms publication cadence;
 * --cadence 80 exercises each delta. --owner selects a frozen bundle of the six owners below.
 * Acceptance: identical emitted-byte hashes/counts, lower allocation or CPU per turn,
 * and no >20% regression in the other metric. Timing excludes output hashing/sampling.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { EmbeddedBlockChunker as DefaultBlockChunker } from "../../src/agents/embedded-agent-block-chunker.js";
import { handleMessageUpdate as defaultHandleMessageUpdate } from "../../src/agents/embedded-agent-subscribe.handlers.messages.update.js";
import type { EmbeddedAgentSubscribeContext as Context } from "../../src/agents/embedded-agent-subscribe.handlers.types.js";
import { EmbeddedAgentSubscribeState as DefaultSubscribeState } from "../../src/agents/embedded-agent-subscribe.run-state.js";
import { createStreamRendering as defaultCreateStreamRendering } from "../../src/agents/embedded-agent-subscribe.stream-rendering.js";
import {
  extractAssistantCommentaryText as defaultExtractCommentary,
  extractAssistantVisibleText as defaultExtractVisible,
} from "../../src/agents/embedded-agent-utils.js";
import { makeAgentAssistantMessage } from "../../src/agents/test-helpers/agent-message-fixtures.js";

// This owner replay excludes diagnostic disk I/O, including operator-enabled raw logging.
process.env.OPENCLAW_RAW_STREAM = "0";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
    owner: { type: "string" },
    cadence: { type: "string", default: "10" },
    turns: { type: "string", default: "3" },
    samples: { type: "string", default: "5" },
  },
});
assert(["verify", "timing", "allocation", "counts"].includes(values.mode));
const cadence = Number(values.cadence);
const turns = Number(values.turns);
const samples = Number(values.samples);
assert([cadence, turns, samples].every((value) => Number.isSafeInteger(value) && value > 0));
const defaultOwners = {
  handleMessageUpdate: defaultHandleMessageUpdate,
  EmbeddedBlockChunker: DefaultBlockChunker,
  EmbeddedAgentSubscribeState: DefaultSubscribeState,
  createStreamRendering: defaultCreateStreamRendering,
  extractAssistantCommentaryText: defaultExtractCommentary,
  extractAssistantVisibleText: defaultExtractVisible,
};
const {
  handleMessageUpdate,
  EmbeddedBlockChunker,
  EmbeddedAgentSubscribeState,
  createStreamRendering,
  extractAssistantCommentaryText,
  extractAssistantVisibleText,
}: typeof defaultOwners = values.owner
  ? await import(pathToFileURL(path.resolve(values.owner)).href)
  : defaultOwners;
if (values.output) {
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
}

const paragraphs: string[] = [];
for (let index = 0; index < 180; index++) {
  const paragraph =
    `Paragraph ${index}: synthetic assistant explanation with ordinary Latin prose. ` +
    "中文段落 保持空格。日本語の文章。한국어 문장. " +
    "The next observation follows the previous result without changing its meaning.";
  paragraphs.push(paragraph);
  if (index % 5 === 0) {
    paragraphs.push(paragraph);
  }
}
const source = paragraphs.map((part, index) => part + (index % 2 ? "\r\n\r\n" : "\n\n")).join("");
const chunks = Array.from({ length: Math.ceil(source.length / 37) }, (_, index) =>
  source.slice(index * 37, (index + 1) * 37),
);
type Workload = "responses-final" | "responses-commentary" | "generic-commentary";
const workloads: Workload[] = ["responses-final", "responses-commentary", "generic-commentary"];
// Captured before optimization on 52c106496b85; covers every emitted payload and terminal text.
const goldenHashes: Record<Workload, string> = {
  "responses-final": "d65a8c48827fb30cab98265a88367ffa9c45de0cea0f1b6e66c4b5994a135a95",
  "responses-commentary": "e72e0e6c8c32c35d4686d58d6f2f330dd2bc188efa2555f34e5ea0f8a02b4181",
  "generic-commentary": "8e332f7fa38ca6a8b0835af2bfdf6be482596562a36a047a76e492e10c4fdedd",
};
let now = 0;
const noOp = () => {};
const unused = (): never => {
  throw new Error("The text-update fixture does not exercise this operation");
};

function replay(workload: Workload, verify: boolean) {
  const output = verify ? createHash("sha256") : undefined;
  let emissions = 0;
  let lastText = "";
  // Only delivery/logging sinks are inert. All parsing, state, and rendering are real.
  const sinks = {
    params: {
      runId: "synthetic-text-replay",
      get session(): Context["params"]["session"] {
        return unused();
      },
    },
    state: new EmbeddedAgentSubscribeState({}),
    log: { debug: noOp, info: noOp, warn: noOp },
    blockChunker: new EmbeddedBlockChunker(),
    noteLastAssistant: noOp,
    flushAssistantStream: noOp,
    emitBlockReply: noOp,
    emitAssistantStreamData: ((data, options) => {
      emissions++;
      lastText = data.text;
      output?.update(JSON.stringify([data, options]));
    }) satisfies Context["emitAssistantStreamData"],
  };
  const ctx: Context = {
    ...sinks,
    ...createStreamRendering({
      ...sinks,
      pendingBlockReplyTasks: new Set(),
      pushAssistantText: noOp,
      shouldSkipAssistantText: () => false,
    }),
    shouldEmitToolResult: unused,
    shouldEmitToolOutput: unused,
    emitToolSummary: unused,
    emitToolOutput: unused,
    resetForCompactionRetry: unused,
    finalizeAssistantTexts: unused,
    trimMessagingToolSent: unused,
    consumeToolSendReceipt: unused,
    ensureCompactionPromise: unused,
    noteCompactionRetry: unused,
    resolveCompactionRetry: unused,
    maybeResolveCompactionWait: unused,
    captureModelEvent: unused,
    incrementCompactionCount: unused,
    noteCompactionTokensAfter: unused,
    getCompactionCount: unused,
    releaseDeferredReplies: unused,
    clearAssistantStream: unused,
    clearDeferredBlockReplies: unused,
  };
  const phase = workload === "responses-final" ? "final_answer" : "commentary";
  const block = {
    type: "text" as const,
    text: "",
    textSignature: JSON.stringify({ v: 1, id: "synthetic-item", phase }),
  };
  const message = makeAgentAssistantMessage({
    content: [block],
    api: workload === "generic-commentary" ? "openai-completions" : "openai-responses",
  });
  now = 1_000;
  for (const chunk of chunks) {
    block.text += chunk;
    now += cadence;
    const pending = handleMessageUpdate(ctx, {
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        delta: chunk,
        contentIndex: 0,
        partial: message,
      },
    });
    assert.equal(pending, undefined);
  }
  const pending = handleMessageUpdate(ctx, {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_end", content: source, contentIndex: 0, partial: message },
  });
  assert.equal(pending, undefined);
  if (verify) {
    const final =
      phase === "final_answer"
        ? extractAssistantVisibleText(message)
        : extractAssistantCommentaryText(message);
    assert.equal(lastText, final);
    output?.update(JSON.stringify({ final }));
  }
  const outputSha256 = output?.digest("hex");
  if (verify && cadence === 10) {
    assert.equal(outputSha256, goldenHashes[workload]);
    assert.equal(emissions, workload === "responses-final" ? 1048 : 132);
    assert.equal(lastText.length, 32108);
  }
  return { emissions, finalCharacters: lastText.length, outputSha256 };
}

const originalNow = Date.now;
Date.now = () => now;
const reports = [];
try {
  for (const workload of workloads) {
    const golden = replay(workload, true);
    if (values.mode === "verify") {
      reports.push({ workload, ...golden });
      continue;
    }
    if (values.mode === "counts") {
      let paragraphScans = 0;
      let paragraphCharacters = 0;
      const probe = mock.method(String.prototype, "matchAll");
      try {
        replay(workload, false);
        for (const call of probe.mock.calls) {
          if (call.arguments[0].source === "\\n+|[^\\n]+") {
            paragraphScans++;
            paragraphCharacters += String(call.this).length;
          }
        }
      } finally {
        probe.mock.restore();
      }
      reports.push({ workload, ...golden, paragraphScans, paragraphCharacters });
      continue;
    }
    for (let warmup = 0; warmup < 3; warmup++) {
      replay(workload, false);
    }
    const measurements = [];
    for (let sample = 0; sample < samples; sample++) {
      globalThis.gc?.();
      const inspector = new Session();
      if (values.mode === "allocation") {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      for (let turn = 0; turn < turns; turn++) {
        assert.equal(replay(workload, false).emissions, golden.emissions);
      }
      const elapsedMs = performance.now() - start;
      const used = process.threadCpuUsage(cpu);
      let sampledBytes: number | undefined;
      if (values.mode === "allocation") {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        inspector.disconnect();
        const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
          node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
        sampledBytes = sum(profile.head);
        if (values.output && sample === 0) {
          await writeFile(`${values.output}.${workload}.heapprofile`, JSON.stringify(profile));
        }
      }
      measurements.push({
        sample,
        elapsedMsPerTurn: elapsedMs / turns,
        cpuMsPerTurn: (used.user + used.system) / 1_000 / turns,
        sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / turns,
      });
    }
    reports.push({ workload, ...golden, measurements });
  }
} finally {
  Date.now = originalNow;
}
const report = {
  node: process.version,
  mode: values.mode,
  cadenceMs: cadence,
  sourceCharacters: source.length,
  sourceBytes: Buffer.byteLength(source),
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  deltas: chunks.length,
  loadAverage: loadavg(),
  turns,
  reports,
};
if (values.output) {
  await writeFile(values.output, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report));
