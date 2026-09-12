import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { isMainThread } from "node:worker_threads";
import {
  GATEWAY_HEAP_PROFILE_CHANNEL,
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  type GatewayHeapProfileCommand,
} from "./gateway-bench-heap.ts";

// Only the benchmark child gets this preload and IPC descriptor. No inspector
// listener or profiler control is exposed through the Gateway protocol.
if (isMainThread) {
  if (!process.send) {
    throw new Error("Gateway heap profiling requires the benchmark IPC channel");
  }
  const inspector = new Session();
  inspector.connect();
  let active = false;
  let busy = false;
  process.on("message", (message: GatewayHeapProfileCommand) => {
    if (message?.channel !== GATEWAY_HEAP_PROFILE_CHANNEL) {
      return;
    }
    const reply = (error?: string) => {
      process.send?.({ channel: GATEWAY_HEAP_PROFILE_CHANNEL, action: message.action, error });
    };
    if (busy) {
      reply("Gateway heap profile command already in progress");
      return;
    }
    busy = true;
    void (async () => {
      if (message.action === "start") {
        if (active) {
          throw new Error("Gateway heap profile already started");
        }
        // Include dead allocations as well as survivors: retained heap alone
        // misses the short-lived objects that cause busy-Gateway GC pressure.
        const options = {
          samplingInterval: GATEWAY_HEAP_SAMPLE_INTERVAL,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        };
        await inspector.post("HeapProfiler.startSampling", options);
        active = true;
      } else if (message.action === "stop") {
        if (!active) {
          throw new Error("Gateway heap profile has not started");
        }
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        active = false;
        writeFileSync(message.profilePath, JSON.stringify(profile), { mode: 0o600 });
      } else {
        throw new Error("Unknown Gateway heap profile command");
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
