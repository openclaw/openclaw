/* oxlint-disable unicorn/require-post-message-target-origin -- Node BroadcastChannel has no targetOrigin argument. */
// Benchmark-only preload: inherited through NODE_OPTIONS by real SQLite workers.
import { Session } from "node:inspector/promises";
import { BroadcastChannel, threadId } from "node:worker_threads";

const channel = new BroadcastChannel(`copilot-journal-${process.pid}`);
channel.unref();
const inspector = new Session();
inspector.connect();
let active = false;
let historyDecodeBytes = 0;
let historyDecodes = 0;
const parse = JSON.parse;
JSON.parse = function (text, reviver) {
  const value = parse(text, reviver);
  if (active && typeof text === "string" && text.includes("copilot-bench-history:")) {
    historyDecodeBytes += Buffer.byteLength(text);
    historyDecodes++;
  }
  return value;
};
channel.addEventListener("message", async ({ data }) => {
  if (data.command === "discover") {
    channel.postMessage({ threadId, kind: "ready" });
  } else if (data.command === "start") {
    historyDecodeBytes = 0;
    historyDecodes = 0;
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    active = true;
    channel.postMessage({ threadId, kind: "started" });
  } else if (data.command === "stop") {
    active = false;
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    channel.postMessage({
      threadId,
      kind: "stopped",
      allocatedBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
      historyDecodeBytes,
      historyDecodes,
    });
  }
});
