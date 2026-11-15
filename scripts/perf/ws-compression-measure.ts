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
 * --streaming --clients 20 --audiences 17,1,2 grows assistant text through
 * --size bytes across 32 updates. --cpu-profile <file> captures only measurement.
 * --windows 15,10 alternates negotiated windows independently of audiences.
 * --heap-mib 2560 --expose-gc (Node flag) retains a pointer-rich synthetic heap.
 * --heap-objects uses distinct message objects instead of repeated references.
 * --buffers counts native buffer requests and correlates slow allocations with GC;
 * unlike --allocations it does not enable the sampled V8 allocation profiler.
 * --sizes 512,16384,262144,4194304 interleaves payload sizes in one resident heap.
 * --burst 32 queues multiple broadcasts before yielding to socket completions.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type WebSocket, WebSocketServer } from "ws";
import { createGatewayBroadcaster } from "../../src/gateway/server-broadcast.js";
import { GatewayClientRegistry } from "../../src/gateway/server/client-registry.js";
import {
  GATEWAY_PER_MESSAGE_DEFLATE,
  installGatewayDeflateCodec,
} from "../../src/gateway/server/ws-compression.js";
import { createGatewayWebSocketTransport } from "../../src/gateway/server/ws-transport.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";
import type { CompressionPeerReport } from "./ws-compression-peers.js";

// Real broadcaster/transport, synthetic admitted recipients. Receivers run in a
// separate process so their inflated buffers cannot trigger GC in the sender.
const { values } = parseArgs({
  options: {
    batches: { type: "string" },
    burst: { type: "string" },
    clients: { type: "string" },
    profiles: { type: "string" },
    size: { type: "string" },
    sizes: { type: "string" },
    port: { type: "string" },
    "start-at": { type: "string" },
    "warm-start-at": { type: "string" },
    "ready-file": { type: "string" },
    codec: { type: "string" },
    transport: { type: "string" },
    allocations: { type: "boolean", default: false },
    streaming: { type: "boolean", default: false },
    audiences: { type: "string" },
    "cpu-profile": { type: "string" },
    windows: { type: "string", default: "15" },
    "heap-mib": { type: "string" },
    "heap-objects": { type: "boolean", default: false },
    warmup: { type: "string" },
    buffers: { type: "boolean", default: false },
    event: { type: "string" },
  },
});
const installCodec: typeof installGatewayDeflateCodec = values.codec
  ? (await import(pathToFileURL(values.codec).href)).installGatewayDeflateCodec
  : installGatewayDeflateCodec;
const createTransport: typeof createGatewayWebSocketTransport = values.transport
  ? (await import(pathToFileURL(values.transport).href)).createGatewayWebSocketTransport
  : createGatewayWebSocketTransport;
function integer(
  label: Exclude<keyof typeof values, "allocations" | "streaming" | "buffers" | "heap-objects">,
  fallback: number,
  min: number,
) {
  return parseStrictIntegerOption({ raw: values[label], fallback, label, min });
}
const batches = integer("batches", 3000, 1);
const burst = integer("burst", 1, 1);
const clientCount = integer("clients", 70, 1);
const audiences = values.audiences
  ?.split(",")
  .map((raw) => parseStrictIntegerOption({ raw, fallback: 1, label: "audiences", min: 1 }));
assert(!audiences || audiences.reduce((sum, count) => sum + count, 0) === clientCount);
const profiles = audiences?.length ?? integer("profiles", 1, 1);
const profileIds = audiences
  ? audiences.flatMap((count, profile) => Array<number>(count).fill(profile))
  : Array.from({ length: clientCount }, (_, index) => index % profiles);
const sizes = values.sizes
  ?.split(",")
  .map((raw) => parseStrictIntegerOption({ raw, fallback: 128, label: "sizes", min: 128 }));
const payloadSize = sizes ? Math.max(...sizes) : integer("size", 16384, 128);
const port = integer("port", 41649, 40000);
const warmStartAt = integer("warm-start-at", 0, 0);
const startAt = integer("start-at", 0, 0);
assert(port <= 65535, "port must be <= 65535");
assert(profiles <= clientCount, "profiles must be <= clients");
assert(!startAt || !warmStartAt || startAt > warmStartAt, "start must follow warmup");
const warmupBatches = integer("warmup", 100, 0);
const heapMiB = integer("heap-mib", 0, 0);
const windows = values.windows.split(",").map(Number);
assert(
  windows.length > 0 && windows.every((bits) => Number.isInteger(bits) && bits >= 9 && bits <= 15),
);
// Model resident references, not disk size: the compression owner performs no I/O.
const resident: { sessionKey: string }[][] = Array.from(
  { length: values["heap-objects"] ? 0 : heapMiB * 2 },
  (_, session) => {
    const reference = { sessionKey: `agent:synthetic:${session}`, revision: session };
    return Array.from({ length: 65536 }, () => reference);
  },
);
if (values["heap-objects"]) {
  const before = process.memoryUsage().heapUsed;
  while (process.memoryUsage().heapUsed - before < heapMiB * 1024 * 1024) {
    const sessionKey = `agent:synthetic:${resident.length}`;
    resident.push(
      Array.from({ length: 4096 }, (_, id) => ({
        sessionKey,
        id,
        content: { type: "text", text: `message-${id}` },
      })),
    );
  }
}
if (heapMiB) {
  assert(global.gc, "--heap-mib requires node --expose-gc");
  global.gc();
}
const event = values.event ?? (values.streaming ? "session.message" : "tick");
const fixtureSizes: number[] = [];
const fixtures = Array.from({ length: 32 }, (_, index) => {
  // Streaming grows a stable transcript prefix; the default corpus mixes sizes.
  const size = sizes
    ? sizes[index % sizes.length]!
    : values.streaming
      ? Math.max(128, Math.floor((payloadSize * (index + 1)) / 32))
      : index % 4 === 0
        ? Math.min(payloadSize, 512)
        : payloadSize;
  fixtureSizes.push(size);
  const generation = values.streaming ? 0 : index;
  const rows = Array.from({ length: Math.ceil(size / 100) }, (_unusedRow, row) => ({
    id: `synthetic-${generation}-${row}`,
    state: row % 3 === 0 ? "running" : "complete",
    text: `line ${row}: result ${((row + 1) * (generation + 17) * 2654435761) >>> 0}; ready\n`,
  }));
  const text = JSON.stringify(rows).slice(0, size - 64);
  return event === "session.message"
    ? {
        sessionKey: "agent:synthetic:stream",
        message: {
          role: "assistant",
          content: values.streaming
            ? [{ type: "text", text }]
            : [
                {
                  type: "toolCall",
                  id: `synthetic-${index}`,
                  name: "exec",
                  arguments: { command: text },
                },
              ],
        },
      }
    : event === "agent"
      ? {
          runId: `synthetic-${index}`,
          stream: "tool",
          data: { phase: "result", result: { content: [{ type: "text", text }] } },
        }
      : { fixture: index, text };
});
const fixtureJson = fixtures.map((payload) => JSON.stringify(payload));
const clients = new GatewayClientRegistry();
const broadcaster = createGatewayBroadcaster({ clients });
const connIds = new Set(Array.from({ length: clientCount }, (_, index) => `synthetic-${index}`));
const server = new WebSocketServer({
  host: "127.0.0.1",
  port,
  perMessageDeflate: GATEWAY_PER_MESSAGE_DEFLATE,
});
let receiver: ChildProcess | undefined;
const streams: Socket[] = [];
let measuring = false;
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
let sending = false;
let explicitBufferBytes = 0;
let explicitBufferCalls = 0;
const sendSpans: { start: number; end: number }[] = [];
const slowAllocations: { start: number; end: number; size: number; owned: boolean }[] = [];
const sendWallMs: number[] = [];
const bySize = new Map<number, { wallMs: number[]; cpuUs: number; bytes: number; calls: number }>();
let externalPeak = 0;
let ownedBufferBytes = 0;
let ownedBufferCalls = 0;
const countBuffers = values.allocations || values.buffers;
const allocUnsafe = Buffer.allocUnsafe.bind(Buffer);
const allocUnsafeSlow = Buffer.allocUnsafeSlow.bind(Buffer);
const concat = Buffer.concat.bind(Buffer);
// Count explicit backing requests only during synchronous broadcast work.
// This complements V8 sampling, which does not include native Buffer storage.
if (countBuffers) {
  const count = (allocate: typeof Buffer.allocUnsafe, owned: boolean) => (size: number) => {
    if (measuring && sending) {
      explicitBufferBytes += size;
      explicitBufferCalls++;
      if (owned) {
        ownedBufferBytes += size;
        ownedBufferCalls++;
      }
      const start = performance.now();
      const result = allocate(size);
      const end = performance.now();
      if (end - start >= 0.1) {
        slowAllocations.push({ start, end, size, owned });
      }
      return result;
    }
    return allocate(size);
  };
  Buffer.allocUnsafe = count(allocUnsafe, false);
  Buffer.allocUnsafeSlow = count(allocUnsafeSlow, true);
  // Supported Node versions allocate concat results internally, bypassing these hooks.
  Buffer.concat = (list, length) => {
    const start = performance.now();
    const result = concat(list, length);
    const end = performance.now();
    if (measuring && sending) {
      explicitBufferBytes += result.length;
      explicitBufferCalls++;
      if (end - start >= 0.1) {
        slowAllocations.push({ start, end, size: result.length, owned: false });
      }
    }
    return result;
  };
}
async function run(count: number, offset: number, latencies?: number[]) {
  for (let batch = 0; batch < count; batch += burst) {
    if (failure) {
      throw failure;
    }
    const started = performance.now();
    const sentCount = Math.min(burst, count - batch);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("broadcast delivery timed out")), 30_000);
      let remaining = sentCount;
      finishBatch = () => {
        if (--remaining === 0) {
          clearTimeout(timeout);
          resolve();
        }
      };
      failBatch = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      for (let item = 0; item < sentCount; item++) {
        const fixtureIndex = (batch + item + offset) % fixtures.length;
        const before = process.threadCpuUsage();
        const beforeBytes = explicitBufferBytes;
        const beforeCalls = explicitBufferCalls;
        // Production serialization creates a fresh frame for every publication.
        sending = true;
        const start = performance.now();
        broadcaster.broadcastToConnIds(event, fixtures[fixtureIndex], connIds);
        const end = performance.now();
        sending = false;
        const used = process.threadCpuUsage(before);
        if (latencies) {
          sendThreadCpuUs += used.user + used.system;
          sendWallMs.push(end - start);
          sendSpans.push({ start, end });
          externalPeak = Math.max(externalPeak, process.memoryUsage().external);
          const size = fixtureSizes[fixtureIndex]!;
          let stats = bySize.get(size);
          if (!stats) {
            stats = { wallMs: [], cpuUs: 0, bytes: 0, calls: 0 };
            bySize.set(size, stats);
          }
          stats.wallMs.push(end - start);
          stats.cpuUs += used.user + used.system;
          stats.bytes += explicitBufferBytes - beforeBytes;
          stats.calls += explicitBufferCalls - beforeCalls;
        }
      }
    });
    latencies?.push(performance.now() - started);
  }
  finishBatch = undefined;
  failBatch = undefined;
}

try {
  await once(server, "listening");
  receiver = fork(
    fileURLToPath(new URL("./ws-compression-peers.ts", import.meta.url)),
    [JSON.stringify({ port, clients: clientCount, windows })],
    {
      execArgv: ["--import", fileURLToPath(new URL("../tsx.mjs", import.meta.url))],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  receiver.on("error", fail);
  receiver.on("exit", (code) => fail(new Error(`receiver exited (${code})`)));
  receiver.on("message", (message: { type: string; error?: string }) => {
    if (message.type === "batch") {
      finishBatch?.();
    } else if (message.type === "error") {
      fail(new Error(message.error));
    }
  });
  for (let index = 0; index < clientCount; index++) {
    const accepted = once(server, "connection", { signal: AbortSignal.timeout(30_000) });
    receiver.send("connect");
    const [socket, request] = (await accepted) as [WebSocket, IncomingMessage];
    assert.equal(socket.extensions, "permessage-deflate");
    socket.on("error", fail);
    streams.push(request.socket);
    clients.add({
      connId: `synthetic-${index}`,
      preparedRecipientProfileId: `profile-${profileIds[index]}`,
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
  const ready = once(receiver, "message", { signal: AbortSignal.timeout(30_000) });
  receiver.send("measure");
  assert.equal((await ready)[0].type, "ready");
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
  const gcEvents: { start: number; duration: number; kind: string }[] = [];
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
      gcEvents.push({ start: entry.startTime, duration: entry.duration, kind: name });
    }
  }
  const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const latencies: number[] = [];
  await waitUntil(startAt, "measurement");
  const inspector = new Session();
  if (values.allocations || values["cpu-profile"]) {
    inspector.connect();
  }
  if (values["cpu-profile"]) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  if (values.allocations) {
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
  const memoryBefore = process.memoryUsage();
  externalPeak = memoryBefore.external;
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
  }
  if (values["cpu-profile"]) {
    const { profile } = await inspector.post("Profiler.stop");
    await writeFile(values["cpu-profile"], JSON.stringify(profile));
  }
  inspector.disconnect();
  const completed = once(receiver, "message", { signal: AbortSignal.timeout(30_000) });
  receiver.send("finish");
  const [report] = (await completed) as [CompressionPeerReport];
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
    assert.equal(report.received[index], batches + warmupBatches);
    assert.equal(report.hashes[index], expectedHashes[profileIds[index]!]);
  }
  const pauses = Object.values(gc).flat();
  const totalGcMs = pauses.reduce((sum, value) => sum + value, 0);
  console.log(
    JSON.stringify({
      workload: {
        batches,
        burst,
        clients: clientCount,
        profiles,
        audiences,
        streaming: values.streaming,
        event,
        payloadSize,
        sizes,
        warmupBatches,
        windows,
        heapMiB,
        heapObjects: values["heap-objects"],
        residentSessions: resident.length,
        receiverProcess: true,
      },
      mode: values.allocations ? "allocation" : "timing",
      allocatedBytes,
      allocatedBytesPerBroadcast:
        allocatedBytes === undefined ? undefined : allocatedBytes / batches,
      explicitBufferBytesPerBroadcast: countBuffers ? explicitBufferBytes / batches : undefined,
      explicitBufferCallsPerBroadcast: countBuffers ? explicitBufferCalls / batches : undefined,
      hostLoadBefore,
      hostLoadAfter,
      memoryBefore,
      externalPeak,
      memory,
      ownedBufferBytesPerBroadcast: countBuffers ? ownedBufferBytes / batches : undefined,
      ownedBufferCallsPerBroadcast: countBuffers ? ownedBufferCalls / batches : undefined,
      sendWall: tails(sendWallMs),
      bySize: Object.fromEntries(
        [...bySize].map(([size, stats]) => [
          size,
          {
            sendWall: tails(stats.wallMs),
            sendThreadCpuUsPerBroadcast: stats.cpuUs / stats.wallMs.length,
            explicitBufferBytesPerBroadcast: countBuffers
              ? stats.bytes / stats.wallMs.length
              : undefined,
            explicitBufferCallsPerBroadcast: countBuffers
              ? stats.calls / stats.wallMs.length
              : undefined,
          },
        ]),
      ),
      slowAllocations: countBuffers
        ? slowAllocations.map((allocation) =>
            Object.assign(allocation, {
              duration: allocation.end - allocation.start,
              gc: gcEvents.filter(
                (entry) =>
                  entry.start < allocation.end && entry.start + entry.duration > allocation.start,
              ),
            }),
          )
        : undefined,
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
      receivedBytes: report.bytes,
      wireBytes,
      wireBytesPerBroadcast: wireBytes / batches,
      hashCorrectness: true,
      hashes: expectedHashes,
      latency: tails(latencies),
      latencyUnit: burst === 1 ? "broadcast" : "burst",
      eventLoopDelay: {
        samples: loop.count,
        p95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
        p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
        maxMs: loop.count ? loop.max / 1e6 : null,
      },
      gc: {
        totalMs: totalGcMs,
        duringSend: gcEvents.filter((entry) =>
          sendSpans.some(
            (span) => entry.start < span.end && entry.start + entry.duration > span.start,
          ),
        ),
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
  Buffer.allocUnsafe = allocUnsafe;
  Buffer.allocUnsafeSlow = allocUnsafeSlow;
  Buffer.concat = concat;
  if (receiver && receiver.exitCode === null && receiver.signalCode === null) {
    const exited = once(receiver, "exit");
    receiver.kill();
    await exited;
  }
  for (const client of clients) {
    client.socket.terminate();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
