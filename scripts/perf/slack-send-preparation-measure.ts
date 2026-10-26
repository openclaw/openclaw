// Slack send-owner benchmark with synthetic config (45 plugins) and a mock WebClient.
// node --import ./scripts/tsx.mjs scripts/perf/slack-send-preparation-measure.ts [--owner saved-send.ts]
// Add --allocations for a separate sampled-allocation pass; traced timing is diagnostic only.
// --iterations defaults to 3000. Run base/candidate in counterbalanced fresh processes.
// Acceptance: identical wireDigest, less CPU/allocated bytes per send, and no material wall/GC rise.
// This measures real send preparation/receipts, not Gateway load, provider delay, or Slack latency.
// The send workload uses no Gateway, database, files, live credentials, or network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SlackBasePostMessagePayload } from "../../extensions/slack/src/post-message-payload.js";
import type { OpenClawConfig } from "../../src/config/types.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    allocations: { type: "boolean", default: false },
    iterations: { type: "string", default: "3000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL("../../extensions/slack/src/send.ts", import.meta.url);
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
const { sendMessageSlack } = await import("../../extensions/slack/src/send.js");
hooks.deregister();
assert(ownerLoaded, "The selected Slack send owner must be loaded");
type SendOptions = Parameters<typeof sendMessageSlack>[2];
type WebClient = NonNullable<SendOptions["client"]>;
type WireRequest = SlackBasePostMessagePayload;
const cfg: OpenClawConfig = {
  channels: {
    slack: {
      accounts: {
        benchmark: { botToken: "xoxb-synthetic-benchmark", unfurlLinks: false },
      },
    },
  },
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [`synthetic-${index}`, { enabled: true }]),
    ),
  },
};
const headers = ["Account", "Region", "Status", "Owner"];
const rows = Array.from({ length: 80 }, (_, index) => [
  `Account ${index}`,
  `Region ${index % 8}`,
  "Ready",
  `Owner ${index % 12}`,
]);
const nativeTable = {
  type: "data_table",
  caption: "Pipeline",
  rows: [headers, ...rows].map((row) => row.map((text) => ({ type: "raw_text", text }))),
};
const orderedBlocks = Array.from({ length: 12 }, (_, index) => ({
  type: "section",
  text: {
    type: "plain_text",
    text: `Section ${index}: ${"synthetic delivery detail ".repeat(6)}`.trim(),
  },
}));
const legacyBlocks = [
  { type: "section", text: { type: "plain_text", text: "Ready for delivery" } },
];
const channel = "C1234567890";
const post = (text: string, extras: Pick<WireRequest, "blocks" | "mrkdwn"> = {}): WireRequest => ({
  channel,
  text,
  ...extras,
  unfurl_links: false,
});
const scenarios: Array<{
  name: string;
  text: string;
  options: Partial<SendOptions>;
  expected: WireRequest;
}> = [
  {
    name: "markdown",
    text: "Hello **team**.\n\nThe shipment is ready.",
    options: {},
    expected: post("Hello *team*.\n\nThe shipment is ready."),
  },
  {
    name: "literal",
    text: `  ${"synthetic delivery detail ".repeat(50)}  `,
    options: { textIsSlackPlainText: true },
    expected: post(`  ${"synthetic delivery detail ".repeat(50)}  `, { mrkdwn: false }),
  },
  {
    name: "legacy-blocks",
    text: "Overview",
    options: { blocks: legacyBlocks },
    expected: post("Overview\n\nReady for delivery", { blocks: legacyBlocks }),
  },
  {
    name: "ordered-blocks",
    text: "",
    options: { blocks: orderedBlocks, authoredTextPlacement: "none" },
    expected: post(orderedBlocks.map((block) => block.text.text).join("\n\n"), {
      blocks: orderedBlocks,
      mrkdwn: false,
    }),
  },
  {
    name: "native-table",
    text: "Overview",
    options: { blocks: [nativeTable] },
    expected: post(
      `Overview\n\nPipeline (table)\n${[headers, ...rows].map((row) => row.join("\t")).join("\n")}`,
      { blocks: [nativeTable], mrkdwn: false },
    ),
  },
];

let latestWire: WireRequest | undefined;
let wireCount = 0;
let dispatchAt = 0;
let transportAt = 0;
// Only chat.postMessage can be reached for these channel-targeted, text/block fixtures.
// The SDK class has private fields; this synthetic transport intentionally supplies its one used method.
const client = {
  chat: {
    postMessage: async (payload: WireRequest) => {
      transportAt = performance.now();
      latestWire = payload;
      wireCount++;
      return { ok: true, ts: "171234.567", channel };
    },
  },
} as unknown as WebClient;
const onPlatformSendDispatch = async () => {
  dispatchAt = performance.now();
};
const sendOptions = scenarios.map((scenario) => ({
  cfg,
  accountId: "benchmark",
  client,
  onPlatformSendDispatch,
  ...scenario.options,
}));
const expectedWires = scenarios.map((scenario) => JSON.stringify(scenario.expected));

async function verifyWire() {
  const digest = createHash("sha256");
  for (const [index, scenario] of scenarios.entries()) {
    const before = wireCount;
    const result = await sendMessageSlack(`channel:${channel}`, scenario.text, sendOptions[index]!);
    assert.equal(wireCount - before, 1, `${scenario.name}: one physical post`);
    const wire = JSON.stringify(latestWire);
    assert.equal(wire, expectedWires[index], `${scenario.name}: exact wire request`);
    assert.equal(result.messageId, "171234.567");
    assert.equal(result.channelId, channel);
    digest.update(wire);
  }
  return digest.digest("hex");
}
const wireDigest = await verifyWire();
async function run(count: number, samples?: Record<Phase, Float64Array>) {
  for (let index = 0; index < count; index++) {
    const scenarioIndex = index % scenarios.length;
    const startedAt = performance.now();
    await sendMessageSlack(
      `channel:${channel}`,
      scenarios[scenarioIndex]!.text,
      sendOptions[scenarioIndex]!,
    );
    const endedAt = performance.now();
    if (samples) {
      samples.prepare[index] = dispatchAt - startedAt;
      samples.dispatchToTransport[index] = transportAt - dispatchAt;
      samples.settle[index] = endedAt - transportAt;
      samples.total[index] = endedAt - startedAt;
    }
    if ((index + 1) % 100 === 0) {
      await nextTurn();
    }
  }
}
const phases = ["prepare", "dispatchToTransport", "settle", "total"] as const;
type Phase = (typeof phases)[number];
await run(Math.min(iterations, 100));
const samples: Record<Phase, Float64Array> = {
  prepare: new Float64Array(iterations),
  dispatchToTransport: new Float64Array(iterations),
  settle: new Float64Array(iterations),
  total: new Float64Array(iterations),
};
wireCount = 0;
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const memoryBefore = process.memoryUsage();
const stopDiagnostics = startGatewayBenchDiagnostics();
const cpu = process.threadCpuUsage();
const start = performance.now();
await run(iterations, samples);
const wallMs = performance.now() - start;
const usedCpu = process.threadCpuUsage(cpu);
await nextTurn();
await nextTurn();
const diagnostics = stopDiagnostics();
const memoryAfter = process.memoryUsage();
const hostLoadAfter = loadavg();
assert.equal(wireCount, iterations);
let allocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
assert.equal(await verifyWire(), wireDigest);
function summarize(phaseSamples: number[]) {
  const sorted = phaseSamples.toSorted((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}
console.log(
  JSON.stringify({
    scope: "Slack send owner with mock transport; no Gateway or provider delay",
    mode: values.allocations ? "sampled-allocation" : "untraced-timing",
    iterations,
    configuredPlugins: Object.keys(cfg.plugins!.entries!).length,
    ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
    wireDigest,
    wirePosts: iterations,
    wallMs,
    threadCpuMs: (usedCpu.user + usedCpu.system) / 1000,
    threadCpuUsPerSend: (usedCpu.user + usedCpu.system) / iterations,
    allocatedBytes,
    allocatedBytesPerSend: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    phases: Object.fromEntries(
      phases.map((phase) => [phase, summarize(Array.from(samples[phase]))]),
    ),
    scenarios: scenarios.map((scenario, index) => ({
      name: scenario.name,
      phases: Object.fromEntries(
        phases.map((phase) => [
          phase,
          summarize(
            Array.from(samples[phase]).filter((_, sample) => sample % scenarios.length === index),
          ),
        ]),
      ),
    })),
    memoryBefore,
    memoryAfter,
    hostLoadBefore,
    hostLoadAfter,
    diagnostics,
  }),
);
