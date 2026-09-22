import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { isMainThread } from "node:worker_threads";
import { startGatewayBenchDiagnostics } from "./gateway-bench-diagnostics.ts";
import {
  GATEWAY_PROFILE_CHANNEL,
  GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  type GatewayBenchCommand,
  type GatewayProfileCommand,
} from "./gateway-bench-profile.ts";
import { GatewayBenchWorkerProfiler } from "./gateway-bench-worker-profile.ts";

// Only the benchmark child gets this preload and IPC descriptor. No inspector
// listener or profiler control is exposed through the Gateway protocol.
if (isMainThread) {
  if (!process.send) {
    throw new Error("Gateway profiling requires the benchmark IPC channel");
  }
  const inspector = new Session();
  const workers = new GatewayBenchWorkerProfiler(inspector);
  let inspectorConnected = false;
  const active = new Set<GatewayProfileCommand["kind"]>();
  const diagnosticCaptures = new Map<
    GatewayProfileCommand["kind"],
    ReturnType<typeof startGatewayBenchDiagnostics>
  >();
  let busy = false;
  process.on("message", (message: GatewayBenchCommand) => {
    if (message?.channel !== GATEWAY_PROFILE_CHANNEL) {
      return;
    }
    if (message.kind === "cpu-usage" && message.action === "sample") {
      process.send?.({
        channel: GATEWAY_PROFILE_CHANNEL,
        kind: message.kind,
        action: message.action,
        cpuUsage: {
          pid: process.pid,
          atMonotonicMicros: Number(process.hrtime.bigint() / 1_000n),
          process: process.cpuUsage(),
          mainThread: process.threadCpuUsage(),
        },
      });
      return;
    }
    const reply = (error?: string) => {
      process.send?.({
        channel: GATEWAY_PROFILE_CHANNEL,
        kind: message.kind,
        action: message.action,
        error,
      });
    };
    if (busy) {
      reply("Gateway profile command already in progress");
      return;
    }
    busy = true;
    void (async () => {
      if (message.kind !== "cpu" && message.kind !== "heap") {
        throw new Error("Unknown Gateway profile kind");
      }
      if (!inspectorConnected) {
        inspector.connect();
        inspectorConnected = true;
      }
      if (message.action === "start") {
        if (active.has(message.kind)) {
          throw new Error(`Gateway ${message.kind} profile already started`);
        }
        if (message.kind === "cpu") {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.setSamplingInterval", {
            interval: GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
          });
          await inspector.post("Profiler.start");
        } else {
          // Include dead allocations as well as survivors: retained heap alone
          // misses the short-lived objects that cause busy-Gateway GC pressure.
          const options = {
            samplingInterval: GATEWAY_HEAP_SAMPLE_INTERVAL,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          };
          await inspector.post("HeapProfiler.startSampling", options);
        }
        active.add(message.kind);
        if (message.includeWorkers) {
          await workers.start(message.kind, message.profilePath);
        }
        diagnosticCaptures.set(message.kind, startGatewayBenchDiagnostics());
      } else if (message.action === "stop") {
        if (!active.has(message.kind)) {
          throw new Error(`Gateway ${message.kind} profile has not started`);
        }
        const diagnostics = diagnosticCaptures.get(message.kind)?.();
        diagnosticCaptures.delete(message.kind);
        try {
          const { profile } =
            message.kind === "cpu"
              ? await inspector.post("Profiler.stop")
              : await inspector.post("HeapProfiler.stopSampling");
          active.delete(message.kind);
          writeFileSync(message.profilePath, JSON.stringify(profile), { mode: 0o600 });
          if (diagnostics) {
            writeFileSync(`${message.profilePath}.diagnostics.json`, JSON.stringify(diagnostics), {
              mode: 0o600,
            });
          }
        } finally {
          await workers.stop(message.kind);
        }
      } else {
        throw new Error("Unknown Gateway profile command");
      }
    })().then(
      () => {
        busy = false;
        reply();
      },
      (error: unknown) => {
        busy = false;
        reply(error instanceof Error ? error.message : String(error));
      },
    );
  });
  process.once("disconnect", () => {
    for (const finish of diagnosticCaptures.values()) {
      finish();
    }
    diagnosticCaptures.clear();
    if (inspectorConnected) {
      inspector.disconnect();
    }
  });
  process.channel?.unref();
}
