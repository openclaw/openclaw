// IPC observer for the synthetic Gateway started by browser-protocol-retention.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { fileURLToPath } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

if (isMainThread && process.send) {
  const sources: Array<{ path: string; sha256?: string }> = [];
  const inspector = new Session();
  inspector.connect();
  inspector.on("Debugger.scriptParsed", ({ params }) => {
    if (!/\/pw-(session-state|tools-core\.interactions\.content)\.ts(?:[?#]|$)/u.test(params.url)) {
      return;
    }
    const sourcePath = params.url.startsWith("file:") ? fileURLToPath(params.url) : params.url;
    sources.push({
      path: sourcePath,
      sha256: existsSync(sourcePath)
        ? createHash("sha256").update(readFileSync(sourcePath)).digest("hex")
        : undefined,
    });
  });
  await inspector.post("Debugger.enable");
  let observing = true;
  const sampler = new Session();
  let measurement:
    | {
        started: number;
        cpu: NodeJS.CpuUsage;
        processCpu: NodeJS.CpuUsage;
        memoryBefore: NodeJS.MemoryUsage;
        allocation: boolean;
      }
    | undefined;
  const capture = async (message: unknown) => {
    if (!isRecord(message) || message.channel !== "browser-protocol-retention") {
      return;
    }
    const reply = (result: Record<string, unknown>) =>
      process.send?.({ channel: message.channel, id: message.id, ...result });
    try {
      assert(typeof message.id === "string");
      if (observing) {
        await inspector.post("Debugger.disable");
        inspector.disconnect();
        observing = false;
      }
      assert(globalThis.gc);
      if (message.action === "start") {
        assert(!measurement);
        globalThis.gc();
        globalThis.gc();
        const memoryBefore = process.memoryUsage();
        const allocation = message.measure === "allocation";
        if (allocation) {
          await startCollectedHeapSampling(sampler, 32768);
        }
        measurement = {
          started: performance.now(),
          cpu: process.threadCpuUsage(),
          processCpu: process.cpuUsage(),
          memoryBefore,
          allocation,
        };
        reply({});
      } else if (message.action === "stop") {
        assert(measurement);
        const wallMs = performance.now() - measurement.started;
        const cpu = process.threadCpuUsage(measurement.cpu);
        const processCpu = process.cpuUsage(measurement.processCpu);
        const memoryBeforeGC = process.memoryUsage();
        let allocatedBytes: number | undefined;
        if (measurement.allocation) {
          const { profile } = await sampler.post("HeapProfiler.stopSampling");
          allocatedBytes = sumSampledHeapBytes(profile.head);
          sampler.disconnect();
        }
        globalThis.gc();
        globalThis.gc();
        reply({
          wallMs,
          cpuMs: (cpu.user + cpu.system) / 1000,
          processCpuMs: (processCpu.user + processCpu.system) / 1000,
          allocatedBytes,
          memoryBefore: measurement.memoryBefore,
          memoryBeforeGC,
          memoryAfterGC: process.memoryUsage(),
        });
        measurement = undefined;
      } else {
        assert(message.action === "snapshot" && typeof message.filename === "string");
        globalThis.gc();
        globalThis.gc();
        const memory = process.memoryUsage();
        writeHeapSnapshot(message.filename);
        reply({ memory, sources });
      }
    } catch (error) {
      reply({ error: String(error) });
    }
  };
  process.on("message", (message: unknown) => {
    void capture(message);
  });
  process.channel?.unref();
}
