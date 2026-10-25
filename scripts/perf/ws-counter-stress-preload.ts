// Private IPC instrumentation for ws-counter-stress.ts; never loaded by normal Gateways.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { onInternalDiagnosticEvent } from "../../src/infra/diagnostic-events.js";

if (isMainThread) {
  let events = 0;
  let frames = 0;
  let bytes = 0;
  let wireBytes = 0;
  let frameBytes: Record<string, number> = {};
  const stop = onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "gateway.ws.event") {
        events++;
        frames += event.count;
        bytes += event.bytes;
        wireBytes += event.wireBytes ?? 0;
        for (const [bound, count] of Object.entries(event.frameBytes ?? {})) {
          frameBytes[bound] = (frameBytes[bound] ?? 0) + count;
        }
      }
    },
    { include: ["gateway.ws.event"] },
  );
  let loop: ReturnType<typeof monitorEventLoopDelay> | undefined;
  process.on("message", (message: { channel?: string; action?: string }) => {
    if (message.channel !== "ws-counter-stress") {
      return;
    }
    if (message.action === "start") {
      events = frames = bytes = wireBytes = 0;
      frameBytes = {};
      loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      process.send?.({ channel: "ws-counter-stress", action: "start" });
    } else if (message.action === "stop" && loop) {
      loop.disable();
      process.send?.({
        channel: "ws-counter-stress",
        action: "stop",
        events,
        frames,
        bytes,
        wireBytes,
        frameBytes,
        loop: {
          count: loop.count,
          p95Ms: loop.percentile(95) / 1e6,
          p99Ms: loop.percentile(99) / 1e6,
          maxMs: loop.max / 1e6,
        },
      });
      loop = undefined;
    }
  });
  process.once("disconnect", stop);
}
