// Preload before Gateway imports. The benchmark parent stops sampling as soon as
// its external /readyz probe succeeds, independently of the first sessions RPC.
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send) {
  const inspector = new Session();
  inspector.connect();
  inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const capture = (message, exiting = false) => {
    if (
      message?.type !== "openclaw-startup-heap:capture" ||
      typeof message.outputPath !== "string"
    ) {
      return;
    }
    process.off("message", onMessage);
    process.off("exit", onExit);
    inspector.post("HeapProfiler.stopSampling", (error, result) => {
      try {
        if (error) {
          throw error;
        }
        writeFileSync(
          message.outputPath,
          JSON.stringify({ ...result.profile, cpuUsage: process.cpuUsage() }),
        );
        if (!exiting) {
          process.send(
            { type: "openclaw-startup-heap:captured", outputPath: message.outputPath },
            () => {},
          );
        }
      } catch (captureError) {
        if (!exiting) {
          process.send(
            { type: "openclaw-startup-heap:captured", error: String(captureError) },
            () => {},
          );
        } else {
          process.stderr.write(`Startup heap capture failed: ${String(captureError)}\n`);
        }
      } finally {
        process.off("disconnect", disconnected);
        inspector.disconnect();
      }
    });
  };
  const onMessage = (message) => {
    capture(message);
  };
  const disconnected = () => {
    process.off("message", onMessage);
    inspector.disconnect();
  };
  // Inspector callbacks run synchronously in this isolate, including fatal process.exit().
  const onExit = () =>
    capture(
      {
        type: "openclaw-startup-heap:capture",
        outputPath: process.env.OPENCLAW_BENCH_HEAP_EXIT_PATH,
      },
      true,
    );
  process.on("message", onMessage);
  process.once("exit", onExit);
  process.once("disconnect", disconnected);
  process.channel?.unref();
}
