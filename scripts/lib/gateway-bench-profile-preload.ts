import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { isMainThread } from "node:worker_threads";
import {
  GATEWAY_PROFILE_CHANNEL,
  GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  type GatewayProfileCommand,
} from "./gateway-bench-profile.ts";

// Only the benchmark child gets this preload and IPC descriptor. No inspector
// listener or profiler control is exposed through the Gateway protocol.
if (isMainThread) {
  if (!process.send) {
    throw new Error("Gateway profiling requires the benchmark IPC channel");
  }
  const inspector = new Session();
  inspector.connect();
  const active = new Set<GatewayProfileCommand["kind"]>();
  let busy = false;
  process.on("message", (message: GatewayProfileCommand) => {
    if (message?.channel !== GATEWAY_PROFILE_CHANNEL) {
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
      } else if (message.action === "stop") {
        if (!active.has(message.kind)) {
          throw new Error(`Gateway ${message.kind} profile has not started`);
        }
        const { profile } =
          message.kind === "cpu"
            ? await inspector.post("Profiler.stop")
            : await inspector.post("HeapProfiler.stopSampling");
        active.delete(message.kind);
        writeFileSync(message.profilePath, JSON.stringify(profile), { mode: 0o600 });
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
  process.once("disconnect", () => inspector.disconnect());
  process.channel?.unref();
}
