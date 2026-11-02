// Preload before Gateway imports. The benchmark parent stops sampling as soon as
// its external /readyz probe succeeds, independently of the first sessions RPC.
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send) {
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const capture = async (message) => {
    if (
      message?.type !== "openclaw-startup-heap:capture" ||
      typeof message.outputPath !== "string"
    ) {
      return;
    }
    process.off("message", onMessage);
    try {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      writeFileSync(message.outputPath, JSON.stringify(profile));
      process.send(
        { type: "openclaw-startup-heap:captured", outputPath: message.outputPath },
        () => {},
      );
    } catch (error) {
      process.send({ type: "openclaw-startup-heap:captured", error: String(error) }, () => {});
    } finally {
      process.off("disconnect", disconnected);
      inspector.disconnect();
    }
  };
  const onMessage = (message) => {
    void capture(message);
  };
  const disconnected = () => {
    process.off("message", onMessage);
    inspector.disconnect();
  };
  process.on("message", onMessage);
  process.once("disconnect", disconnected);
  process.channel?.unref();
}
