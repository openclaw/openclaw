/**
 * Owner probe: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/ws-event-metrics-measure.ts --output .local/buf136/base.json
 * Run unchanged on base/candidate in alternating order. Defaults: five warm
 * 2,000-turn timing passes and a separate 10,000-turn sampled-allocation pass.
 * Each turn records raw and wire bytes for 65 synthetic sockets, then drains the
 * real owner/exporter. The .metrics golden must match byte-for-byte. This measures
 * telemetry ownership, not network delivery or whole-Gateway performance.
 * Compare allocation/frame and main-thread CPU/frame; GC and loop tails need
 * matched A/A controls before an adverse conclusion. --iterations/--repeats make
 * short probes possible; --port selects an isolated loopback port (>=40000).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { dirname } from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createDiagnosticsPrometheusExporter } from "../../extensions/diagnostics-prometheus/src/service.js";
import { recordGatewayWsEvent } from "../../src/gateway/server/ws-connection-diagnostics.js";
import {
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../src/infra/diagnostic-events.js";
import type {
  GatewayWsPresenceMode,
  GatewayWsSessionEventAttribution,
} from "../../src/infra/diagnostic-rpc-types.js";
import { createPluginRuntimeCapabilityLease } from "../../src/plugins/capability-lease.js";
import { withPluginRuntimeGatewayRequestScope } from "../../src/plugins/runtime/gateway-request-scope.js";
import { createPluginServiceDiagnostics } from "../../src/plugins/service-diagnostics.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string" },
    repeats: { type: "string" },
    output: { type: "string" },
    port: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2_000,
  min: 1,
  label: "iterations",
});
const repeats = parseStrictIntegerOption({
  raw: values.repeats,
  fallback: 5,
  min: 1,
  label: "repeats",
});
const port = parseStrictIntegerOption({
  raw: values.port,
  fallback: 41636,
  min: 40000,
  label: "port",
});
assert(port <= 65535, "port must be <= 65535");
assert(global.gc, "run with --expose-gc");
const sockets = 65;
const variants: {
  event: string;
  sessionEvent?: GatewayWsSessionEventAttribution;
  presenceMode?: GatewayWsPresenceMode;
}[] = [
  { event: "chat" },
  { event: "presence", presenceMode: "delta" },
  { event: "session.message", sessionEvent: { reason: "assistant", delivery: "subscribed" } },
  { event: "session.message", sessionEvent: { reason: "assistant", delivery: "roster" } },
  { event: "unknown" },
];
const sizes = [256, 257, 1024, 65537];
const exporter = createDiagnosticsPrometheusExporter();
const lease = createPluginRuntimeCapabilityLease("diagnostics-prometheus");
const internalDiagnostics = createPluginServiceDiagnostics(
  {
    id: "diagnostics-prometheus",
    pluginId: "diagnostics-prometheus",
    origin: "bundled",
    source: "synthetic-ws-measurement",
    service: exporter.service,
  },
  lease,
);
assert(internalDiagnostics);
const context = {
  config: {},
  stateDir: ".local/buf136/synthetic",
  internalDiagnostics,
  logger: {
    info() {},
    warn() {},
    debug() {},
    error(message: string) {
      throw new Error(message);
    },
  },
};
const server = createServer((req, res) => {
  void withPluginRuntimeGatewayRequestScope(
    {
      isWebchatConnect: () => false,
      client: {
        connId: "synthetic-scrape",
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "gateway-client", version: "synthetic", platform: "node", mode: "backend" },
          scopes: ["operator.read"],
        },
      },
    },
    () => exporter.handler(req, res),
  );
});
async function scrape() {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(response.status, 200);
  return (
    (await response.text())
      .split("\n")
      .filter((line) => line.includes("openclaw_gateway_ws_"))
      .join("\n") + "\n"
  );
}
async function run(count: number) {
  for (let turn = 0; turn < count; turn++) {
    for (let socket = 0; socket < sockets; socket++) {
      const variant = variants[socket % variants.length]!;
      recordGatewayWsEvent(
        variant.event,
        sizes[socket % sizes.length]!,
        variant.sessionEvent,
        variant.presenceMode,
      );
      recordGatewayWsEvent(variant.event, 0, undefined, undefined, 128);
    }
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
  }
}
function tails(samples: number[]) {
  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] ?? null,
    p99Ms: samples[Math.ceil(samples.length * 0.99) - 1] ?? null,
    maxMs: samples.at(-1) ?? null,
    totalMs: samples.reduce((sum, value) => sum + value, 0),
  };
}
async function timingPass() {
  global.gc!();
  const gc = { minor: [] as number[], major: [] as number[], other: [] as number[] };
  let started = Infinity;
  let ended = Infinity;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime < started || entry.startTime > ended) {
        continue;
      }
      const { kind } = (entry as typeof entry & { detail: { kind: number } }).detail;
      gc[
        kind === constants.NODE_PERFORMANCE_GC_MINOR
          ? "minor"
          : kind === constants.NODE_PERFORMANCE_GC_MAJOR
            ? "major"
            : "other"
      ].push(entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  await yieldImmediate();
  const hostLoad = loadavg();
  const before = process.threadCpuUsage();
  started = performance.now();
  await run(iterations);
  ended = performance.now();
  const cpu = process.threadCpuUsage(before);
  loop.disable();
  await yieldImmediate();
  observer.disconnect();
  const wallMs = ended - started;
  const gcMs = [...gc.minor, ...gc.major, ...gc.other].reduce((sum, value) => sum + value, 0);
  return {
    iterations,
    frames: iterations * sockets,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuUsPerFrame: (cpu.user + cpu.system) / (iterations * sockets),
    hostLoad,
    memory: process.memoryUsage(),
    gc: {
      minor: tails(gc.minor),
      major: tails(gc.major),
      other: tails(gc.other),
      totalMs: gcMs,
      msPerMinute: (gcMs * 60_000) / wallMs,
    },
    loop: {
      samples: loop.count,
      p95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
      p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
      maxMs: loop.count ? loop.max / 1e6 : null,
    },
  };
}
async function allocationPass() {
  global.gc!();
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await run(iterations * repeats);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let bytes = 0;
    let ownerBytes = 0;
    function visit(node: HeapProfiler.SamplingHeapProfileNode, owned = false) {
      const underOwner =
        owned ||
        /\/(?:ws-connection-diagnostics|diagnostic-events|service-gateway-ws)\./.test(
          node.callFrame.url,
        );
      bytes += node.selfSize;
      if (underOwner) {
        ownerBytes += node.selfSize;
      }
      for (const child of node.children) {
        visit(child, underOwner);
      }
    }
    visit(profile.head);
    const frames = iterations * repeats * sockets;
    return {
      iterations: iterations * repeats,
      frames,
      sampledBytes: bytes,
      bytesPerFrame: bytes / frames,
      ownerBytes,
      ownerBytesPerFrame: ownerBytes / frames,
    };
  } finally {
    inspector.disconnect();
  }
}
try {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  setDiagnosticsEnabledForProcess(true);
  exporter.service.start(context);
  await run(10);
  const golden = await scrape();
  assert(golden.includes('openclaw_gateway_ws_events_total{event="chat"} 130\n'));
  if (values.output) {
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(`${values.output}.metrics`, golden);
  }
  exporter.service.stop();
  exporter.service.start(context);
  const warmup = 100;
  await run(warmup);
  const timings = [];
  for (let index = 0; index < repeats; index++) {
    timings.push(await timingPass());
  }
  const allocation = await allocationPass();
  const metrics = await scrape();
  const expectedCount = (warmup + iterations * repeats * 2) * sockets;
  const recordedCount = metrics
    .split("\n")
    .filter((line) => line.startsWith("openclaw_gateway_ws_events_total{"))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
  assert.equal(recordedCount, expectedCount);
  const json =
    JSON.stringify(
      {
        node: process.version,
        workload:
          "65 socket observations per turn; real WS diagnostic owner and Prometheus exporter",
        timings,
        allocation,
        expectedCount,
      },
      null,
      2,
    ) + "\n";
  if (values.output) {
    await writeFile(values.output, json);
  }
  console.log(json);
} finally {
  exporter.service.stop();
  lease.revoke();
  server.closeAllConnections();
  await new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
  });
}
