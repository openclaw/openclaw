/**
 * Real tool-call normalization with cumulative provider snapshots and small deltas.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-call-markdown-measure.ts --kind inline
 * --owner points at a pinned package source tree; preserve its relative imports.
 * Run base/candidate alternately at least five times, plus unchanged A/A controls.
 * Repeat with --mode allocation; sampled CPU is not timing evidence.
 * Acceptance: identical replay, lower parsed characters/allocation, no >20% CPU regression.
 * Owner-only synthetic proof: no Gateway, provider, filesystem inventory, or database IO.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findMarkdownCodeRegions } from "../../packages/markdown-core/src/reasoning-tags.js";
import type * as repair from "../../packages/tool-call-repair/src/index.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    kind: { type: "string", default: "inline" },
    mode: { type: "string", default: "timing" },
    owner: { type: "string", default: "packages/tool-call-repair/src/index.ts" },
    "compare-owner": { type: "string" },
    turns: { type: "string", default: "5" },
    paragraphs: { type: "string", default: "128" },
    "chunk-size": { type: "string", default: "16" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(["plain", "inline", "fences", "call", "false-prefix"].includes(values.kind));
const count = (label: "turns" | "paragraphs" | "chunk-size", fallback: number) =>
  parseStrictIntegerOption({ raw: values[label], fallback, min: 1, label });
const turns = count("turns", 5);
const paragraphs = count("paragraphs", 128);
const chunkSize = count("chunk-size", 16);
const owner: typeof repair = await import(pathToFileURL(resolve(values.owner)).href);
const nameList = Array.from({ length: 40 }, (_, index) => `read_${index}`);
const names = new Set(nameList);
const matcher = {
  hasExactName: (name: string) => names.has(name),
  hasNamePrefix: (prefix: string) => nameList.some((name) => name.startsWith(prefix)),
};
const paragraph = {
  plain: "The agent explains the result and describes the next step.\n\n",
  inline: "The agent explains `read_0` and describes the next step.\n\n",
  fences: 'Example:\n\n```json\n[tool:read_0]\n{"path":"example"}\n```\n\n',
  call: "read `example` then continue. ",
  "false-prefix": "[read_0 is a literal `example`, with no call payload.\n\n",
}[values.kind];
assert(paragraph);
const body = paragraph.repeat(paragraphs);
const input = values.kind === "call" ? `[tool:read_0]\n${JSON.stringify({ path: body })}\n` : body;
const content = (text: string) => [{ type: "text", text }];
const message = (text: string) => ({
  role: "assistant",
  content: content(text),
  stopReason: "stop",
});
const events: Record<string, unknown>[] = [{ type: "start", partial: message("") }];
events.push({ type: "text_start", contentIndex: 0, content: "", partial: message("") });
for (let offset = 0; offset < input.length; offset += chunkSize) {
  const end = Math.min(input.length, offset + chunkSize);
  events.push({
    type: "text_delta",
    contentIndex: 0,
    delta: input.slice(offset, end),
    partial: message(input.slice(0, end)),
  });
}
events.push({ type: "text_end", contentIndex: 0, content: input, partial: message(input) });
events.push({ type: "done", reason: "stop", message: message(input) });
const deltas = Math.ceil(input.length / chunkSize);
let resolverCalls = 0;
let parsedCalls = 0;
let parsedCharacters = 0;
let largestParse = 0;
const resolveProtectedRanges: repair.PlainTextToolCallProtectedRangeResolver = (text) => {
  resolverCalls++;
  // This is the canonical resolver's exact early-return guard; only the other branch parses.
  if (/[`~\t]| {4}/u.test(text)) {
    parsedCalls++;
    parsedCharacters += text.length;
    largestParse = Math.max(largestParse, text.length);
  }
  return findMarkdownCodeRegions(text);
};
const options = (
  implementation: typeof repair,
): repair.PlainTextToolCallStreamNormalizerOptions => ({
  matcher,
  resolveProtectedRanges,
  protectedRangesFenceCompatible: true,
  createPromotedToolCallEvents: implementation.createPromotedPlainTextToolCallEvents,
  normalizeTerminalMessage: ({ allowPromotion, ...params }) => {
    const promoted =
      allowPromotion &&
      implementation.projectStandalonePlainTextToolCallMessage({
        ...params,
        allowedToolNames: names,
        resolveProtectedRanges,
        createToolCallBlock: (block, name) => ({
          type: "toolCall",
          id: "fixture-call",
          name,
          arguments: block.arguments,
        }),
      });
    if (promoted) {
      return { kind: "promoted", ...promoted };
    }
    const scrubbed = implementation.projectScrubbedPlainTextToolCallMessage({
      ...params,
      matcher,
      resolveProtectedRanges,
    });
    return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
  },
});
async function* source() {
  yield* events;
}
async function run(implementation = owner, record = false) {
  const recording: unknown[] = [];
  let visible = "";
  let terminal: unknown;
  let outputEvents = 0;
  for await (const event of implementation.normalizePlainTextToolCallStreamEvents(
    source(),
    options(implementation),
  )) {
    assert(event && typeof event === "object" && "type" in event);
    if (event.type === "text_delta" && "delta" in event) {
      assert(typeof event.delta === "string");
      visible += event.delta;
    }
    if (event.type === "done" && "message" in event) {
      terminal = event.message;
    }
    if (record) {
      recording.push(structuredClone(event));
    }
    outputEvents++;
  }
  assert.equal(visible, values.kind === "call" ? "" : input);
  assert.deepEqual(
    terminal,
    values.kind === "call"
      ? {
          ...message(input),
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "fixture-call", name: "read_0", arguments: { path: body } },
          ],
        }
      : message(input),
  );
  return { recording, outputEvents };
}
const coldStart = performance.now();
const coldCpuStart = process.threadCpuUsage();
await run();
const coldCpu = process.threadCpuUsage(coldCpuStart);
const coldMs = performance.now() - coldStart;
if (values["compare-owner"]) {
  const comparison: typeof repair = await import(
    pathToFileURL(resolve(values["compare-owner"])).href
  );
  assert.deepEqual((await run(owner, true)).recording, (await run(comparison, true)).recording);
}
await run();
globalThis.gc?.();
resolverCalls = parsedCalls = parsedCharacters = largestParse = 0;
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const wallMs: number[] = [];
const cpuMs: number[] = [];
let outputEvents = 0;
for (let index = 0; index < turns; index++) {
  const start = performance.now();
  const cpuStart = process.threadCpuUsage();
  outputEvents += (await run()).outputEvents;
  const cpu = process.threadCpuUsage(cpuStart);
  cpuMs.push((cpu.user + cpu.system) / 1000);
  wallMs.push(performance.now() - start);
}
let sampledBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    kind: values.kind,
    mode: values.mode,
    owner: values.owner,
    turns,
    paragraphs,
    chunkSize,
    inputCharacters: input.length,
    deltas,
    inputEventsPerTurn: events.length,
    outputEventsPerTurn: outputEvents / turns,
    resolverCallsPerTurn: resolverCalls / turns,
    parsedCallsPerTurn: parsedCalls / turns,
    parsedCharactersPerTurn: parsedCharacters / turns,
    parsedCharactersPerDelta: parsedCharacters / turns / deltas,
    largestParse,
    coldMs,
    coldCpuMs: (coldCpu.user + coldCpu.system) / 1000,
    wallMs,
    cpuMs,
    sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / turns,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
