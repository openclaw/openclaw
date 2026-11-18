// IPC-only main-isolate observer for browser-playwright-load.ts.
import { createRequire } from "node:module";
import { PerformanceObserver } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send) {
  const require = createRequire(import.meta.url);
  let gcMs = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  process.on("message", (message) => {
    if (message?.channel !== "browser-playwright-load") {
      return;
    }
    globalThis.gc();
    setImmediate(() => {
      process.send({
        channel: message.channel,
        id: message.id,
        snapshot: {
          memory: process.memoryUsage(),
          mainCpu: process.threadCpuUsage(),
          gcMs,
          playwrightModules: Object.keys(require.cache).filter((file) =>
            /[/\\]playwright-core[/\\]/.test(file),
          ),
        },
      });
    });
  });
  process.channel?.unref();
}
