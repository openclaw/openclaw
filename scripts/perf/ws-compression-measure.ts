/**
 * Real broadcast fanout, with byte-for-byte decoded output verification.
 * node --import ./scripts/tsx.mjs scripts/perf/ws-compression-measure.ts \
 *   --clients 60 --profiles 1 --batches 3000 --size 16384 --port 41649
 * Repeat at 1/10/60 clients, alternating base/candidate order. --codec loads an
 * alternate codec module; --transport loads an alternate transport module.
 * --allocations runs a separate sampled-allocation pass including collected
 * objects. Timing/GC gates use untraced passes only.
 * Accept reduced allocation/send CPU per broadcast with identical wire bytes;
 * unique profiles (--profiles 60) bound the no-whole-frame-sharing overhead.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import type { Socket } from "node:net";
import { loadavg } from "node:os";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { createGatewayBroadcaster } from "../../src/gateway/server-broadcast.js";
import { GatewayClientRegistry } from "../../src/gateway/server/client-registry.js";
import {
  GATEWAY_PER_MESSAGE_DEFLATE,
  installGatewayDeflateCodec,
} from "../../src/gateway/server/ws-compression.js";
import { createGatewayWebSocketTransport } from "../../src/gateway/server/ws-transport.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

// Real broadcaster/transport, synthetic admitted recipients. Clients share this
// process; sendThreadCpuUs separately isolates synchronous broadcast work.
const { values } = parseArgs({
  options: {
    batches: { type: "string" },
    clients: { type: "string" },
    profiles: { type: "string" },
    size: { type: "string" },
    port: { type: "string" },
    "start-at": { type: "string" },
    "warm-start-at": { type: "string" },
    "ready-file": { type: "string" },
    codec: { type: "string" },
    transport: { type: "string" },
    allocations: { type: "boolean", default: false },
  },
});
const installCodec: typeof installGatewayDeflateCodec = values.codec
  ? (await import(pathToFileURL(values.codec).href)).installGatewayDeflateCodec
  : installGatewayDeflateCodec;
const createTransport: typeof createGatewayWebSocketTransport = values.transport
  ? (await import(pathToFileURL(values.transport).href)).createGatewayWebSocketTransport
  : createGatewayWebSocketTransport;
function integer(
  label: Exclude<keyof typeof values, "allocations">,
  fallback: number,
  min: number,
) {
  return parseStrictIntegerOption({ raw: values[label], fallback, label, min });
}
const batches = integer("batches", 3000, 1);
const clientCount = integer("clients", 70, 1);
const profiles = integer("profiles", 1, 1);
const payloadSize = integer("size", 16384, 128);
const port = integer("port", 41649, 40000);
const warmStartAt = integer("warm-start-at", 0, 0);
const startAt = integer("start-at", 0, 0);
assert(port <= 65535, "port must be <= 65535");
assert(profiles <= clientCount, "profiles must be <= clients");
assert(!startAt || !warmStartAt || startAt > warmStartAt, "start must follow warmup");
const warmupBatches = 100;
const event = "tick";
const fixtures = Array.from({ length: 32 }, (_, index) => {
  // Every fourth event stays below the compression threshold; the remaining
  // events mix repeated JSON structure with deterministic varied text.
  const size = index % 4 === 0 ? Math.min(payloadSize, 512) : payloadSize;
  const rows = Array.from({ length: Math.ceil(size / 100) }, (_unusedRow, row) => ({
    id: `synthetic-${index}-${row}`,
    state: row % 3 === 0 ? "running" : "complete",
    text: `line ${row}: result ${((row + 1) * (index + 17) * 2654435761) >>> 0}; ready\n`,
  }));
  return { fixture: index, text: JSON.stringify(rows).slice(0, size - 64) };
});
const fixtureJson = fixtures.map((payload) => JSON.stringify(payload));
const clients = new GatewayClientRegistry();
const broadcaster = createGatewayBroadcaster({ clients });
const server = new WebSocketServer({
  host: "127.0.0.1",
  port,
  perMessageDeflate: GATEWAY_PER_MESSAGE_DEFLATE,
});
const peers: WebSocket[] = [];
const streams: Socket[] = [];
const received = new Uint32Array(clientCount);
const hashes = Array.from({ length: clientCount }, () => createHash("sha256"));
let measuring = false;
let receivedBytes = 0;
let batchReceived = 0;
let finishBatch: (() => void) | undefined;
let failBatch: ((error: Error) => void) | undefined;
let failure: Error | undefined;
function fail(error: Error) {
  failure = error;
  failBatch?.(error);
}
async function waitUntil(deadline: number, label: string) {
  if (!deadline) {
    return;
  }
  const waitMs = deadline - Date.now();
  assert(waitMs > 0, `${label} preparation missed synchronized deadline`);
  await delay(waitMs);
}
function tails(samples: number[]) {
  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    medianMs: samples.length ? samples[Math.ceil(samples.length * 0.5) - 1] : null,
    p95Ms: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null,
    p99Ms: samples.length ? samples[Math.ceil(samples.length * 0.99) - 1] : null,
    maxMs: samples.at(-1) ?? null,
  };
}
let sendThreadCpuUs = 0;
async function run(count: number, offset: number, latencies?: number[]) {
  for (let batch = 0; batch < count; batch++) {
    if (failure) {
      throw failure;
    }
    batchReceived = 0;
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("broadcast delivery timed out")), 30_000);
      finishBatch = () => {
        clearTimeout(timeout);
        resolve();
      };
      failBatch = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const before = process.threadCpuUsage();
      // Production serialization creates a fresh frame for every publication.
      broadcaster.broadcast(event, fixtures[(batch + offset) % fixtures.length]);
      const used = process.threadCpuUsage(before);
      if (latencies) {
        sendThreadCpuUs += used.user + used.system;
      }
    });
    latencies?.push(performance.now() - started);
  }
  finishBatch = undefined;
  failBatch = undefined;
}

try {
  await once(server, "listening");
  for (let index = 0; index < clientCount; index++) {
    const accepted = once(server, "connection");
    const peer = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: {} });
    peers.push(peer);
    peer.on("error", fail);
    peer.on("message", (raw, binary) => {
      try {
        assert(!binary && Buffer.isBuffer(raw), "expected a JSON text frame");
        received[index] = received[index]! + 1;
        if (measuring) {
          hashes[index]!.update(raw);
          receivedBytes += raw.byteLength;
        }
        if (++batchReceived === clientCount) {
          finishBatch?.();
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    await once(peer, "open");
    const [socket, request] = (await accepted) as [WebSocket, IncomingMessage];
    assert.equal(peer.extensions, "permessage-deflate");
    socket.on("error", fail);
    streams.push(request.socket);
    clients.add({
      connId: `synthetic-${index}`,
      preparedRecipientProfileId: `profile-${index % profiles}`,
      socket: createTransport(socket, request.socket, installCodec(socket)),
      usesSharedGatewayAuth: false,
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "openclaw-control-ui", version: "synthetic", platform: "node", mode: "ui" },
        role: "operator",
        scopes: ["operator.admin"],
      },
    });
  }
  if (values["ready-file"]) {
    await writeFile(values["ready-file"], JSON.stringify({ pid: process.pid, prepared: true }));
  }
  console.log("WS_COMPRESSION_PREPARED");
  await waitUntil(warmStartAt, "warmup");
  const warmStartedAtEpochMs = Date.now();
  await run(warmupBatches, 0);
  console.log("WS_COMPRESSION_WARMED");
  const gc: Record<string, number[]> = {
    minor: [],
    major: [],
    incremental: [],
    weakcb: [],
    other: [],
  };
  let started = Infinity;
  let ended = Infinity;
  function recordGc(entries: PerformanceEntry[]) {
    for (const entry of entries) {
      if (entry.startTime < started || entry.startTime > ended) {
        continue;
      }
      const { kind } = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
      const name =
        kind === constants.NODE_PERFORMANCE_GC_MINOR
          ? "minor"
          : kind === constants.NODE_PERFORMANCE_GC_MAJOR
            ? "major"
            : kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL
              ? "incremental"
              : kind === constants.NODE_PERFORMANCE_GC_WEAKCB
                ? "weakcb"
                : "other";
      gc[name]!.push(entry.duration);
    }
  }
  const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const latencies: number[] = [];
  await waitUntil(startAt, "measurement");
  const inspector = new Session();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  loop.reset();
  const wireBefore = streams.reduce((sum, socket) => sum + socket.bytesWritten, 0);
  console.log("WS_COMPRESSION_MEASURE_START");
  const startedAtEpochMs = Date.now();
  const processAgeAtStartMs = process.uptime() * 1000;
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  started = performance.now();
  measuring = true;
  await run(batches, warmupBatches, latencies);
  measuring = false;
  ended = performance.now();
  const threadCpu = process.threadCpuUsage(threadBefore);
  const cpu = process.cpuUsage(cpuBefore);
  const hostLoadAfter = loadavg();
  const memory = process.memoryUsage();
  const wireBytes = streams.reduce((sum, socket) => sum + socket.bytesWritten, 0) - wireBefore;
  loop.disable();
  console.log("WS_COMPRESSION_MEASURE_END");
  await delay(10);
  recordGc(observer.takeRecords());
  observer.disconnect();
  let allocatedBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  // Verify every decoded byte, sequence and recipient after timing. No parsing
  // or large expected-output generation is included in the measured work.
  const expectedHashes = Array.from({ length: profiles }, (_, profile) => {
    const hash = createHash("sha256");
    for (let batch = 0; batch < batches; batch++) {
      const sequence = warmupBatches + batch + 1;
      const payload = fixtureJson[(batch + warmupBatches) % fixtures.length];
      hash.update(
        `{"type":"event","event":"${event}","payload":${payload},"seq":${sequence},"recipientProfileId":"profile-${profile}"}`,
      );
    }
    return hash.digest("hex");
  });
  for (let index = 0; index < clientCount; index++) {
    assert.equal(received[index], batches + warmupBatches);
    assert.equal(hashes[index]!.digest("hex"), expectedHashes[index % profiles]);
  }
  const pauses = Object.values(gc).flat();
  const totalGcMs = pauses.reduce((sum, value) => sum + value, 0);
  console.log(
    JSON.stringify({
      workload: { batches, clients: clientCount, profiles, payloadSize, warmupBatches },
      mode: values.allocations ? "allocation" : "timing",
      allocatedBytes,
      allocatedBytesPerBroadcast:
        allocatedBytes === undefined ? undefined : allocatedBytes / batches,
      hostLoadBefore,
      hostLoadAfter,
      memory,
      warmStartedAtEpochMs,
      startedAtEpochMs,
      processAgeAtStartMs,
      wallMs: ended - started,
      cpuUs: cpu.user + cpu.system,
      cpuUsPerBroadcast: (cpu.user + cpu.system) / batches,
      threadCpuUs: threadCpu.user + threadCpu.system,
      threadCpuUsPerBroadcast: (threadCpu.user + threadCpu.system) / batches,
      sendThreadCpuUs,
      sendThreadCpuUsPerBroadcast: sendThreadCpuUs / batches,
      frames: batches * clientCount,
      receivedBytes,
      wireBytes,
      wireBytesPerBroadcast: wireBytes / batches,
      hashCorrectness: true,
      hashes: expectedHashes,
      latency: tails(latencies),
      eventLoopDelay: {
        samples: loop.count,
        p95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
        p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
        maxMs: loop.count ? loop.max / 1e6 : null,
      },
      gc: {
        totalMs: totalGcMs,
        msPerBroadcast: totalGcMs / batches,
        ...tails(pauses),
        byKind: Object.fromEntries(
          Object.entries(gc).map(([kind, kindPauses]) => [
            kind,
            { totalMs: kindPauses.reduce((sum, value) => sum + value, 0), ...tails(kindPauses) },
          ]),
        ),
      },
    }),
  );
} finally {
  for (const peer of peers) {
    peer.terminate();
  }
  for (const client of clients) {
    client.socket.terminate();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
