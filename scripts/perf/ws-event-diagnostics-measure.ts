import assert from "node:assert/strict";
import { once } from "node:events";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as yieldImmediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import type { GatewayConnectionTransport } from "../../src/gateway/server/connection-transport.js";
import { recordGatewayWsEvent } from "../../src/gateway/server/ws-connection-diagnostics.js";
import { createGatewayWebSocketTransport } from "../../src/gateway/server/ws-transport.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../src/infra/diagnostic-events.js";
import type {
  GatewayWsPresenceMode,
  GatewayWsSessionEventAttribution,
} from "../../src/infra/diagnostic-rpc-types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    batches: { type: "string" },
    frames: { type: "string" },
    "start-at": { type: "string" },
    "cpu-start-at": { type: "string" },
    transport: { type: "boolean", default: false },
    port: { type: "string" },
  },
});
const batches = parseStrictIntegerOption({
  raw: values.batches,
  fallback: 250,
  label: "batches",
  min: 1,
});
const frames = parseStrictIntegerOption({
  raw: values.frames,
  fallback: 1_000,
  label: "frames",
  min: 1,
});
const startAt = parseStrictIntegerOption({
  raw: values["start-at"],
  fallback: 0,
  label: "start-at",
  min: 0,
});
const cpuStartAt = parseStrictIntegerOption({
  raw: values["cpu-start-at"],
  fallback: 0,
  label: "cpu-start-at",
  min: 0,
});
const port = parseStrictIntegerOption({
  raw: values.port,
  fallback: 41587,
  label: "port",
  min: 40000,
});
assert(port <= 65535, "port must be <= 65535");
assert(global.gc, "run with --expose-gc");
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
const payloads = variants.map(({ event }) => {
  const envelope = { type: "event", event, payload: "" };
  return Buffer.from(
    JSON.stringify({ ...envelope, payload: "x".repeat(1024 - JSON.stringify(envelope).length) }),
  );
});
const bounds = ["256", "512", "1024", "2048", "4096", "8192", "16384", "65536", "+Inf"];
const histograms = new Float64Array(bounds.length);
let delivered = 0;
let bytes = 0;
let wireBytes = 0;
let received = 0;
let receivedBytes = 0;
let activePayload = payloads[0]!;
let batchReceived = 0;
let finishBatch: (() => void) | undefined;
const clients: WebSocket[] = [];
const transports: GatewayConnectionTransport[] = [];
const socketFrames = new Float64Array(values.transport ? frames : 0);
let server: WebSocketServer | undefined;
const inspector = new Session();
const unsubscribe = onInternalDiagnosticEvent(
  (event) => {
    if (event.type === "gateway.ws.event") {
      delivered += event.count;
      bytes += event.bytes;
      wireBytes += event.wireBytes ?? 0;
      for (let index = 0; index < bounds.length; index++) {
        histograms[index] = histograms[index]! + (event.frameBytes?.[bounds[index]!] ?? 0);
      }
    }
  },
  { include: ["gateway.ws.event"] },
);
setDiagnosticsEnabledForProcess(true);

async function setupTransport() {
  server = new WebSocketServer({ host: "127.0.0.1", port, perMessageDeflate: false });
  server.on("connection", (socket, request) => {
    transports.push(createGatewayWebSocketTransport(socket, request.socket, undefined));
  });
  await once(server, "listening");
  for (let index = 0; index < frames; index++) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false });
    clients.push(client);
    client.on("message", (data, binary) => {
      assert.equal(binary, false);
      assert(Buffer.isBuffer(data));
      assert(data.equals(activePayload));
      received++;
      receivedBytes += data.byteLength;
      socketFrames[index] = socketFrames[index]! + 1;
      if (++batchReceived === frames) {
        finishBatch!();
      }
    });
    await once(client, "open");
  }
  assert.equal(transports.length, frames);
}

async function run(count: number, latencies?: number[]) {
  for (let batch = 0; batch < count; batch++) {
    const started = latencies ? performance.now() : 0;
    if (values.transport) {
      const variant = variants[batch % variants.length]!;
      activePayload = payloads[batch % variants.length]!;
      batchReceived = 0;
      const arrived = new Promise<void>((resolve) => {
        finishBatch = resolve;
      });
      for (const transport of transports) {
        const encodedBytes = transport.send(activePayload, { binary: false });
        transport.recordEventSent!(
          variant.event,
          activePayload,
          variant.sessionEvent,
          variant.presenceMode,
          encodedBytes,
        );
      }
      await arrived;
    } else {
      for (let frame = 0; frame < frames; frame++) {
        const variant = variants[frame % variants.length]!;
        recordGatewayWsEvent(variant.event, 1024, variant.sessionEvent, variant.presenceMode);
        recordGatewayWsEvent(variant.event, 0, undefined, undefined, 256);
      }
    }
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
    if (latencies) {
      latencies[batch] = performance.now() - started;
    }
  }
}

async function allocation(count: number, deadline = 0) {
  global.gc!();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  if (deadline) {
    const waitMs = deadline - Date.now();
    assert(waitMs > 0, "allocation preparation missed --start-at");
    // Arm sampling before the deadline; both sides include this idle timer's allocation.
    await delay(waitMs);
  }
  const startedAtEpochMs = Date.now();
  const started = performance.now();
  await run(count);
  const wallMs = performance.now() - started;
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let total = 0;
  let owner = 0;
  function visit(node: HeapProfiler.SamplingHeapProfileNode, owned = false) {
    const underOwner =
      owned ||
      node.callFrame.url.includes("/ws-connection-diagnostics.") ||
      node.callFrame.functionName === "recordGatewayWsEvent" ||
      node.callFrame.functionName === "flushEventCounters";
    total += node.selfSize;
    if (underOwner) {
      owner += node.selfSize;
    }
    for (const child of node.children) {
      visit(child, underOwner);
    }
  }
  visit(profile.head);
  return {
    startedAtEpochMs,
    totalBytes: total,
    ownerBytes: owner,
    bytesPerFrame: total / (count * frames),
    ownerBytesPerFrame: owner / (count * frames),
    bytesPerBroadcast: total / count,
    ownerBytesPerBroadcast: owner / count,
    wallMs,
    ...(values.transport
      ? {
          bytesPerSocketSecond: total / ((frames * wallMs) / 1000),
          ownerBytesPerSocketSecond: owner / ((frames * wallMs) / 1000),
        }
      : {}),
  };
}

function tails(samples: number[]) {
  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    p95Ms: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null,
    p99Ms: samples.length ? samples[Math.ceil(samples.length * 0.99) - 1] : null,
    maxMs: samples.at(-1) ?? null,
  };
}

async function cpuPass(deadline = 0) {
  const gc = { minor: [] as number[], major: [] as number[], other: [] as number[] };
  let started = Infinity;
  let ended = Infinity;
  function recordGc(entries: PerformanceEntry[]) {
    for (const entry of entries) {
      if (entry.startTime < started || entry.startTime > ended) {
        continue;
      }
      const { kind } = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
      const bucket =
        kind === constants.NODE_PERFORMANCE_GC_MINOR
          ? gc.minor
          : kind === constants.NODE_PERFORMANCE_GC_MAJOR
            ? gc.major
            : gc.other;
      bucket.push(entry.duration);
    }
  }
  global.gc!();
  const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
  const loop = monitorEventLoopDelay({ resolution: 1 });
  const latencies: number[] = [];
  loop.enable();
  await delay(10);
  observer.observe({ entryTypes: ["gc"] });
  if (deadline) {
    const waitMs = deadline - Date.now();
    assert(waitMs > 0, "CPU preparation missed --cpu-start-at");
    await delay(waitMs);
  }
  loop.reset();
  console.log("WS_DIAGNOSTICS_CPU_START");
  const cpuStartedAtEpochMs = Date.now();
  const before = process.cpuUsage();
  started = performance.now();
  await run(batches, latencies);
  ended = performance.now();
  const cpu = process.cpuUsage(before);
  loop.disable();
  console.log("WS_DIAGNOSTICS_CPU_END");
  await delay(10);
  recordGc(observer.takeRecords());
  observer.disconnect();
  const wallMs = ended - started;
  const totalGcMs = [...gc.minor, ...gc.major, ...gc.other].reduce(
    (sum, duration) => sum + duration,
    0,
  );
  return {
    cpuStartedAtEpochMs,
    cpuUs: cpu.user + cpu.system,
    cpuUsPerFrame: (cpu.user + cpu.system) / (batches * frames),
    cpuUsPerBroadcast: (cpu.user + cpu.system) / batches,
    wallMs,
    batchLatency: tails(latencies),
    eventLoopDelay: {
      samples: loop.count,
      p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
      maxMs: loop.count ? loop.max / 1e6 : null,
    },
    gc: {
      samples: gc.minor.length + gc.major.length + gc.other.length,
      totalMs: totalGcMs,
      msPerFrame: totalGcMs / (batches * frames),
      msPerBroadcast: totalGcMs / batches,
      ...Object.fromEntries(
        Object.entries(gc).map(([kind, pauses]) => [
          kind,
          {
            totalMs: pauses.reduce((sum, duration) => sum + duration, 0),
            ...tails(pauses),
          },
        ]),
      ),
    },
  };
}

try {
  if (values.transport) {
    await setupTransport();
  }
  inspector.connect();
  const cold = await allocation(1);
  await run(25);
  const warm = await allocation(batches, startAt);
  const cpu = await cpuPass(cpuStartAt);
  const expectedFrames = (1 + 25 + batches * 2) * frames;
  assert.equal(delivered, expectedFrames);
  assert.equal(bytes, expectedFrames * 1024);
  assert.equal(wireBytes, values.transport ? 0 : expectedFrames * 256);
  for (let index = 0; index < bounds.length; index++) {
    assert.equal(histograms[index], index < 2 ? 0 : expectedFrames);
  }
  if (values.transport) {
    assert.equal(received, expectedFrames);
    assert.equal(receivedBytes, bytes);
    for (const count of socketFrames) {
      assert.equal(count, expectedFrames / frames);
    }
  }
  unsubscribe();
  const inactiveStart = process.cpuUsage();
  for (let frame = 0; frame < batches * frames; frame++) {
    assert.equal(recordGatewayWsEvent("chat", 1024), false);
  }
  const inactiveCpu = process.cpuUsage(inactiveStart);
  console.log(
    JSON.stringify({
      mode: values.transport ? "transport" : "recorder",
      batches,
      framesPerBatch: frames,
      cold,
      warm,
      ...cpu,
      coldBytesPerFrame: cold.bytesPerFrame,
      coldOwnerBytesPerFrame: cold.ownerBytesPerFrame,
      bytesPerFrame: warm.bytesPerFrame,
      ownerBytesPerFrame: warm.ownerBytesPerFrame,
      inactiveCpuUsPerFrame: (inactiveCpu.user + inactiveCpu.system) / (batches * frames),
      frames: delivered,
      bytes,
      wireBytes,
      histogram: histograms.at(-1),
      ...(values.transport ? { received, receivedBytes, sockets: frames } : {}),
    }),
  );
} finally {
  unsubscribe();
  inspector.disconnect();
  for (const client of clients) {
    client.terminate();
  }
  for (const transport of transports) {
    transport.terminate();
  }
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
}
