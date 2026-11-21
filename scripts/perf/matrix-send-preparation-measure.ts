// Matrix send-owner benchmark: long assistant replies through real sendMessageMatrix and a mock client.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/matrix-send-preparation-measure.ts [--owner saved-chunking.ts]
// --owner loads a saved extensions/matrix/src/matrix/send/chunking.ts at the canonical module URL.
// --iterations defaults to 24 rounds; a round sends ~24k chars per shape back to back per workload.
// Thread CPU is read per batch (scheduler-tick granularity); wall is per send. --allocations samples.
// Each batch starts after a full GC, so one workload's garbage does not land in another's tail.
// Call counts come from a child process with precise coverage enabled before Matrix code compiles.
// Run base/candidate in counterbalanced fresh processes (ABBA) with the same dependency tree.
// Acceptance: identical wireDigest per workload, no ownership parse on long replies without
// underline tags, less preparation CPU there, and unchanged underline/spoiler/single-event controls.
// This measures Matrix text preparation and mock dispatch, not Gateway load, model delay,
// encryption, or homeserver latency. It uses no Gateway, database, files, credentials, or network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chunkMarkdownTextWithMode, resolveChunkMode } from "../../src/auto-reply/chunk.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    allocations: { type: "boolean", default: false },
    counts: { type: "boolean", default: false },
    iterations: { type: "string", default: "24" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const collectGarbage = globalThis.gc ?? assert.fail("Run with node --expose-gc");
const inspector = new Session();
if (values.counts) {
  // Block counters compiled in from the start keep function counts exact after inlining.
  inspector.connect();
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
}
const ownerUrl = new URL("../../extensions/matrix/src/matrix/send/chunking.ts", import.meta.url);
const ownerSource = readFileSync(values.owner ?? ownerUrl, "utf8");
let ownerLoaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    ownerLoaded = true;
    return { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true };
  },
});
const { sendMessageMatrix } = await import("../../extensions/matrix/src/matrix/send.js");
const { setMatrixRuntime } = await import("../../extensions/matrix/src/runtime.js");
hooks.deregister();
assert(ownerLoaded, "The selected Matrix chunking owner must be loaded");
type SendOptions = Parameters<typeof sendMessageMatrix>[2];
// Text sends read only these two runtime helpers; both are the core owners the Gateway wires in.
setMatrixRuntime({
  channel: { text: { chunkMarkdownTextWithMode, resolveChunkMode } },
} as unknown as Parameters<typeof setMatrixRuntime>[0]);

// Deterministic assistant-shaped replies, built from whole sections until each reaches its size.
let seed = 0;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
const words = "the gateway retries delivery after a failure so users rarely notice".split(" ");
const hangul = "메모리 업황은 하반기부터 회복될 가능성이 높다 재고 조정이 마무리 단계다".split(" ");
const spans = ["`sendMessage()`", "`retryPolicy`", "`config.yaml`", "`--verbose`", "`HTTP 429`"];
function sentence(vocabulary = words, codeRate = 0) {
  const parts = Array.from({ length: 9 + Math.floor(random() * 9) }, () => pick(vocabulary));
  if (random() < codeRate) {
    parts.splice(Math.floor(random() * parts.length), 0, pick(spans));
  }
  if (random() < 0.2) {
    parts[1] = `**${parts[1]}**`;
  }
  return `${parts.join(" ")}.`;
}
const paragraph = (count: number, codeRate = 0, vocabulary = words) =>
  Array.from({ length: count }, () => sentence(vocabulary, codeRate)).join(" ");
const bullets = (count: number, codeRate: number, indent: string) =>
  Array.from({ length: count }, (_, i) => {
    const item = `- ${sentence(words, codeRate)}`;
    return i % 2 ? `${item}\n${indent}- ${sentence(words, codeRate)}` : item;
  }).join("\n");
const fence = (lines: number) =>
  ["```ts", ...Array.from({ length: lines }, (_, i) => `const r${i} = await send({ id: ${i} });`)]
    .concat("```")
    .join("\n");
const table = (rows: number) =>
  ["| Setting | Default | Notes |", "|---|---|---|"]
    .concat(Array.from({ length: rows }, (_, i) => `| \`opt${i}\` | ${i * 10} | ${sentence()} |`))
    .join("\n");
const shapes = {
  technical: (i: number) => [
    paragraph(3, 0.4),
    bullets(5, 0.4, "  "),
    ...(i % 2 ? [fence(8)] : []),
  ],
  research: (i: number) => [
    paragraph(4, 0.05),
    bullets(6, 0.05, "    "),
    ...(i % 3 ? [] : [table(5)]),
  ],
  prose: () => [paragraph(5), paragraph(4)],
  korean: () => [paragraph(5, 0, hangul), `- ${sentence(hangul)}\n- ${sentence(hangul)}`],
  "code-heavy": () => [paragraph(1, 0.6), fence(14), paragraph(1, 0.6)],
  underline: () => [`${paragraph(3, 0.4)} Keep <u>${sentence()}</u>`, bullets(5, 0.4, "  ")],
  spoiler: () => [`${paragraph(2, 0.4)} ||${sentence()}||`, bullets(5, 0.4, "  ")],
};
type Shape = keyof typeof shapes;
function reply(shape: Shape, size: number) {
  seed = 1234;
  const sections: string[] = [];
  let length = 0;
  while (length < size) {
    const heading = `## ${sections.length + 1}. ${pick(["Overview", "Details", "Next steps"])}`;
    sections.push([heading, ...shapes[shape](sections.length)].join("\n\n"));
    length += sections.at(-1)!.length + 2;
  }
  return sections.join("\n\n");
}
// The single-event control repeats more so its tiny per-round CPU batch spans several ticks.
const workloads = [
  { name: "single-event-2k", text: reply("technical", 2000), repeat: 32 },
  ...(Object.keys(shapes) as Shape[]).flatMap((shape) =>
    [6, 12, 24].map((k) => ({
      name: `${shape}-${k}k`,
      text: reply(shape, k * 1000),
      repeat: 24 / k,
    })),
  ),
];
for (const { name, text } of workloads) {
  assert.equal(/<\/?(?:u|ins)\b/iu.test(text), name.startsWith("underline"), `${name}: <u>`);
  assert.equal(text.includes("||"), name.startsWith("spoiler"), `${name}: spoiler`);
}

let events: unknown[] = [];
let preparedAt = 0;
// The SDK class has private fields; this synthetic client supplies the methods a text send uses.
const client = {
  getUserId: async () => "@bot:example.org",
  prepareRoomForMessageSend: async () => "m.room.message",
  sendMessage: async (_roomId: string, content: unknown) => {
    preparedAt = events.length === 0 ? performance.now() : preparedAt;
    events.push(content);
    return `$event${events.length}`;
  },
} as unknown as NonNullable<SendOptions["client"]>;
const sendOptions: SendOptions = { cfg: {}, client };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
async function send(text: string) {
  events = [];
  const startedAt = performance.now();
  await sendMessageMatrix("room:!room:example.org", text, sendOptions);
  return { prepareMs: preparedAt - startedAt, totalMs: performance.now() - startedAt };
}
async function verifyWire() {
  const wires: Array<{ events: number; wireDigest: string }> = [];
  for (const { text } of workloads) {
    await send(text);
    const wire = events.map((content) => JSON.stringify(content)).join("\n");
    wires.push({ events: events.length, wireDigest: sha256(wire) });
  }
  return wires;
}
const wires = await verifyWire();
for (const [index, { name }] of workloads.entries()) {
  assert.equal(wires[index]!.events === 1, name === "single-event-2k", `${name}: event count`);
}
const counted = [
  ["prepareMatrixMarkdownSource", "/extensions/matrix/src/matrix/format-spoiler-ranges.ts"],
  ["parseMarkdownOwnership", "/packages/markdown-core/src/reasoning-tag-parser.ts"],
] as const;
async function countCalls() {
  const calls: Array<Record<string, number>> = [];
  for (const { text } of workloads) {
    await inspector.post("Profiler.takePreciseCoverage");
    await send(text);
    const { result } = await inspector.post("Profiler.takePreciseCoverage");
    const count = (name: string, path: string) =>
      result
        .filter((script) => script.url.split("?")[0]!.endsWith(path))
        .flatMap((script) => script.functions.filter((fn) => fn.functionName === name))
        .reduce((total, fn) => total + fn.ranges[0]!.count, 0);
    calls.push(Object.fromEntries(counted.map(([name, path]) => [name, count(name, path)])));
  }
  return calls;
}

const samples = workloads.map(({ repeat }) => ({
  prepareMs: new Float64Array(iterations * repeat),
  totalMs: new Float64Array(iterations * repeat),
  cpuUsPerSend: new Float64Array(iterations),
}));
const usec = (usage: NodeJS.CpuUsage) => usage.user + usage.system;
async function run(rounds: number, record: boolean) {
  for (let round = 0; round < rounds; round++) {
    for (const [index, { text, repeat }] of workloads.entries()) {
      const sample = samples[index]!;
      collectGarbage();
      const cpu = process.threadCpuUsage();
      for (let offset = round * repeat; offset < (round + 1) * repeat; offset++) {
        const { prepareMs, totalMs } = await send(text);
        if (record) {
          sample.prepareMs[offset] = prepareMs;
          sample.totalMs[offset] = totalMs;
        }
      }
      if (record) {
        sample.cpuUsPerSend[round] = usec(process.threadCpuUsage(cpu)) / repeat;
      }
      assert.equal(events.length, wires[index]!.events);
    }
    await nextTurn();
  }
}
async function measure() {
  await run(Math.min(iterations, 4), false);
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const stopDiagnostics = startGatewayBenchDiagnostics();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  await run(iterations, true);
  const wallMs = performance.now() - start;
  const threadCpuMs = usec(process.threadCpuUsage(cpu)) / 1000;
  await nextTurn();
  await nextTurn();
  const diagnostics = stopDiagnostics();
  const hostLoadAfter = loadavg();
  let allocatedBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  assert.deepEqual(await verifyWire(), wires);
  const owner = values.owner ? ["--owner", values.owner] : [];
  const script = fileURLToPath(import.meta.url);
  const calls = JSON.parse(
    execFileSync(process.execPath, [...process.execArgv, script, "--counts", ...owner], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ) as Array<Record<string, number>>;
  const underline = calls[workloads.findIndex(({ name }) => name === "underline-24k")]!;
  assert(
    counted.every(([name]) => underline[name]! > 0),
    "Coverage must see counted functions",
  );
  const summarize = (series: Float64Array) => {
    const sorted = series.toSorted();
    const at = (quantile: number) => sorted[Math.ceil(sorted.length * quantile) - 1];
    const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
    return { mean, p50: at(0.5), p95: at(0.95), max: at(1) };
  };
  const sends = workloads.reduce((total, { repeat }) => total + repeat * iterations, 0);
  console.log(
    JSON.stringify({
      scope: "Matrix text send owner with mock client; no Gateway, crypto, or homeserver delay",
      mode: values.allocations ? "sampled-allocation" : "untraced-timing",
      node: process.version,
      iterations,
      sends,
      ownerSha256: sha256(ownerSource),
      wireDigest: sha256(wires.map((wire) => wire.wireDigest).join("\n")),
      wallMs,
      threadCpuMs,
      allocatedBytes,
      allocatedBytesPerSend: allocatedBytes === undefined ? undefined : allocatedBytes / sends,
      workloads: workloads.map(({ name, text, repeat }, index) => ({
        name,
        chars: text.length,
        textSha256: sha256(text).slice(0, 12),
        events: wires[index]!.events,
        wireDigest: wires[index]!.wireDigest,
        sends: repeat * iterations,
        cpuUsPerSend: summarize(samples[index]!.cpuUsPerSend),
        prepareMs: summarize(samples[index]!.prepareMs),
        totalMs: summarize(samples[index]!.totalMs),
        callsPerSend: calls[index],
      })),
      hostLoadBefore,
      hostLoadAfter,
      diagnostics,
    }),
  );
}
if (values.counts) {
  console.log(JSON.stringify(await countCalls()));
} else {
  await measure();
}
