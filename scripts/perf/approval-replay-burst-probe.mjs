// Diagnostic preload for approval-replay-burst-measure.ts; only owned child processes load it.
import { channel } from "node:diagnostics_channel";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send) {
  let active = false;
  let handlerMs = [];
  let admissionMs = [];
  let queueMs = [];
  let startedAt = 0;
  let cpu;
  let inspector;
  const samplingIntervalBytes = 16384;
  channel("openclaw.gateway.rpc").subscribe((event) => {
    if (!active || event.method !== "sessions.messages.subscribe") {
      return;
    }
    if (event.phase === "handler") {
      handlerMs.push(event.durationMs);
      admissionMs.push(event.admissionMs);
    }
    if (event.phase === "dispatch") {
      queueMs.push(event.queueWaitMs ?? 0);
    }
  });
  async function control(message) {
    if (message?.approvalBurst === "start") {
      handlerMs = [];
      admissionMs = [];
      queueMs = [];
      if (message.allocation) {
        inspector = new Session();
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: samplingIntervalBytes,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      cpu = process.threadCpuUsage();
      startedAt = performance.now();
      active = true;
      process.send({ started: true });
    } else if (message?.approvalBurst === "stop") {
      active = false;
      if (inspector) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        inspector.disconnect();
        inspector = undefined;
        const mainThreadSampledBytes = profile.samples.reduce((sum, entry) => sum + entry.size, 0);
        process.send({
          handlerCount: handlerMs.length,
          mainThreadSampledBytes,
          mainThreadSampledBytesPerSubscribe: mainThreadSampledBytes / handlerMs.length,
          allocationSamples: profile.samples.length,
          samplingIntervalBytes,
          memory: process.memoryUsage(),
        });
        return;
      }
      process.send({
        handlerCount: handlerMs.length,
        handlerMs,
        admissionMs,
        queueMs,
        mainThreadCpuUs: process.threadCpuUsage(cpu),
        elapsedMs: performance.now() - startedAt,
        memory: process.memoryUsage(),
      });
    }
  }
  process.on("message", (message) => {
    void control(message).catch((/** @type {unknown} */ error) => {
      process.send({ error: String(error) });
    });
  });
}
