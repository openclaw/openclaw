/**
 * Compare five serial before/after pairs and A/A controls on the same Node runtime.
 * Run timing, allocation, and byte measurement separately.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/spawn-broker-owner-write-measure.ts \
 *   --shape rows --mode timing --writes 600 [--source-root /path/to/checkout]
 *
 * The fixture uses a real broker subprocess, resource lease, and socket. The
 * codec touches transmitted rows, so the fixture scales the payload directly.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MessageChannel } from "node:worker_threads";
import type { SpawnBrokerHost } from "../../src/process/spawn-broker/host.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    shape: { type: "string", default: "control" },
    mode: { type: "string", default: "timing" },
    writes: { type: "string" },
    "source-root": { type: "string" },
  },
});
assert(["control", "rows", "framed"].includes(values.shape));
assert(["timing", "allocation", "bytes"].includes(values.mode));
const writes = parseStrictIntegerOption({
  raw: values.writes,
  label: "--writes",
  fallback: 600,
  min: 1,
});
const root = values["source-root"] ?? fileURLToPath(new URL("../../", import.meta.url));
const source = (name: string) =>
  pathToFileURL(path.resolve(root, "src/process/spawn-broker", name)).href;
const { createSpawnBrokerHost }: typeof import("../../src/process/spawn-broker/host.js") =
  await import(source("host.ts"));
const {
  attachBrokerNativeResource,
}: typeof import("../../src/process/spawn-broker/resource-client.js") = await import(
  source("resource-client.ts")
);

let wireBytes = 0;
let nativeWrites = 0;
function measureWire(host: SpawnBrokerHost) {
  // Measure the final Node IPC frame, including the native length prefix.
  const child: ChildProcess = Reflect.get(host, "process");
  const channelKey = Object.getOwnPropertySymbols(child).find(
    (key) => key.description === "kChannelHandle",
  );
  assert(channelKey, "Node IPC channel handle unavailable");
  const channel: {
    writeBuffer: (request: unknown, buffer: Buffer, ...args: unknown[]) => number;
  } = Reflect.get(child, channelKey);
  const write = channel.writeBuffer;
  channel.writeBuffer = function (request, buffer, ...args) {
    wireBytes += buffer.length;
    nativeWrites++;
    return write.call(this, request, buffer, ...args);
  };
  return () => {
    channel.writeBuffer = write;
  };
}

const alive = setTimeout(() => {
  throw new Error("Broker benchmark timed out");
}, 25_000);
const host = createSpawnBrokerHost({ nativeResources: true });
const { port1, port2 } = new MessageChannel();
let lease: ReturnType<typeof host.captureNativeResource> | undefined;
let client: ReturnType<typeof attachBrokerNativeResource> | undefined;
try {
  await host.ready();
  const fixture = `
    export function createNativeWorkerResource(target, _input, owner) {
      let cpu, expected, seen;
      target.on("message", count => {
        seen = 0;
        expected = count;
        cpu = process.cpuUsage();
        target.postMessage("ready");
      });
      owner.on("message", packet => {
        if (packet.index !== seen++) throw new Error("Owner messages delivered out of order");
        if (packet.check) {
          target.postMessage(packet);
        } else if (seen === expected) {
          const used = process.cpuUsage(cpu);
          target.postMessage({seen, cpu:used.user + used.system});
        }
      });
      return { close() {} };
    }`;
  const created = Promise.withResolvers<void>();
  lease = host.captureNativeResource(
    { moduleUrl: `data:text/javascript,${encodeURIComponent(fixture)}`, ownerPort: true },
    {
      message() {},
      failed: (error) => {
        throw error;
      },
    },
  );
  const owner = lease;
  client = attachBrokerNativeResource(
    lease.attachment,
    port1,
    (response) => {
      if (response.type === "resource-created") {
        created.resolve();
      }
    },
    created.reject,
  );
  await created.promise;
  const payload =
    values.shape === "control"
      ? { ok: true }
      : {
          rows: Array.from({ length: values.shape === "framed" ? 768 : 80 }, (_, i) => ({
            sessionId: `session-${i}`,
            messageId: `message-${i}`,
            role: i % 3 ? "assistant" : "user",
            content: [
              {
                type: "text",
                text: `Synthetic request ${i} / résumés / search and recall\n`.repeat(36),
              },
            ],
            metadata: new Map([
              ["updated", BigInt(i)],
              ["end", undefined],
            ]),
          })),
          digest: new Uint8Array([1, 3, 5, 8]),
        };
  async function ready(count: number) {
    const event = once(port2, "message");
    port2.postMessage(count);
    assert.equal((await event)[0], "ready");
  }
  await ready(1);
  const echo = once(port2, "message");
  const original = { index: 0, value: payload, check: true };
  owner.ownerMessage(original);
  original.index = -1;
  assert.deepEqual((await echo)[0], { index: 0, value: payload, check: true });

  const batch = 12;
  async function sendBatch(count: number) {
    await ready(count);
    const completion = once(port2, "message");
    for (let index = 0; index < count; index++) {
      owner.ownerMessage({ index, value: payload });
    }
    const [result] = await completion;
    assert.equal(result.seen, count);
    return result.cpu as number;
  }
  for (let i = 0; i < 5; i++) {
    await sendBatch(batch);
  }

  const session = new Session();
  if (values.mode === "allocation") {
    await startCollectedHeapSampling(session, 4096);
  }
  const stopWireMeasurement = values.mode === "bytes" ? measureWire(host) : undefined;
  const latencies: number[] = [];
  let childCpu = 0;
  let wallUs = 0;
  const cpu = process.cpuUsage();
  for (let offset = 0; offset < writes; offset += batch) {
    const count = Math.min(batch, writes - offset);
    const start = performance.now();
    childCpu += await sendBatch(count);
    const elapsed = (performance.now() - start) * 1000;
    wallUs += elapsed;
    latencies.push(elapsed / count);
  }
  const parent = process.cpuUsage(cpu);
  stopWireMeasurement?.();
  let allocation = 0;
  if (values.mode === "allocation") {
    const { profile } = await session.post("HeapProfiler.stopSampling");
    session.disconnect();
    allocation = sumSampledHeapBytes(profile.head);
  }
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      node: process.version,
      load: loadavg(),
      shape: values.shape,
      mode: values.mode,
      writes,
      parentCpuUs: (parent.user + parent.system) / writes,
      childCpuUs: childCpu / writes,
      wallUs: wallUs / writes,
      p95WallUs: latencies[Math.ceil(0.95 * latencies.length) - 1],
      ...(values.mode === "bytes" && { bytesPerWrite: wireBytes / writes, nativeWrites }),
      ...(values.mode === "allocation" && { allocationPerWrite: allocation / writes }),
    }),
  );
} finally {
  await lease?.close();
  lease?.release();
  client?.dispose();
  port1.close();
  port2.close();
  await host.close();
  clearTimeout(alive);
}
