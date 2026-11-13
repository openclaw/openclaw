// Synthetic Gateway diagnostic only. Counts live native registrations without
// retaining their FSWatcher objects; post-GC snapshots preserve constructor proof.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { writeHeapSnapshot } from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const watches = new Map();
  const watch = fs.watch;
  let nextId = 0;
  fs.watch = function (...args) {
    const watcher = watch.apply(this, args);
    const id = nextId++;
    const source = new Error().stack?.split("\n").slice(2, 8).join("\n");
    watches.set(id, {
      path: String(args[0]),
      recursive: args[1]?.recursive === true,
      source,
    });
    watcher.once("close", () => watches.delete(id));
    return watcher;
  };
  syncBuiltinESMExports();
  process.on("message", (message) => {
    if (message?.channel !== "fswatcher-retention") {
      return;
    }
    global.gc();
    global.gc();
    writeHeapSnapshot(message.snapshot);
    const duplicates = new Map();
    for (const entry of watches.values()) {
      const key = JSON.stringify([entry.path, entry.recursive]);
      duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
    }
    process.channel?.ref();
    process.send(
      {
        channel: message.channel,
        snapshot: message.snapshot,
        watches: [...watches.values()],
        duplicates: [...duplicates].filter(([, count]) => count > 1),
        memory: process.memoryUsage(),
        cpu: process.threadCpuUsage(),
      },
      () => process.channel?.unref(),
    );
  });
  process.channel?.unref();
}
