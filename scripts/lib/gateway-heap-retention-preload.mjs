import { writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";

// This private IPC channel exists only in the isolated benchmark child.
if (isMainThread) {
  if (!process.send || typeof globalThis.gc !== "function") {
    throw new Error("Heap retention benchmark requires IPC and --expose-gc");
  }
  process.on("message", (message) => {
    if (message?.channel !== "openclaw-heap-retention") {
      return;
    }
    try {
      globalThis.gc();
      globalThis.gc();
      const memory = process.memoryUsage();
      const snapshot = message.snapshotPath ? writeHeapSnapshot(message.snapshotPath) : undefined;
      process.send({
        channel: message.channel,
        id: message.id,
        pid: process.pid,
        memory,
        snapshot,
      });
    } catch (error) {
      process.send({ channel: message.channel, id: message.id, error: String(error) });
    }
  });
  process.channel?.unref();
}
