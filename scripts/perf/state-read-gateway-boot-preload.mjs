// Private IPC observer for state-read-gateway-boot.ts; no listener or runtime seam.
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send) {
  let lifecycle;
  const sample = async (message) => {
    if (message?.channel !== "state-read-gateway-boot") {
      return;
    }
    try {
      const memory = process.memoryUsage();
      const resource = process.resourceUsage();
      const mainCpu = process.threadCpuUsage();
      const totalCpu = process.cpuUsage();
      if (!lifecycle) {
        const directory = path.dirname(process.argv[1]);
        const file = readdirSync(directory).find((name) => /^worker-cpu-[\w-]+\.mjs$/.test(name));
        if (!file) {
          throw new Error("Built worker CPU module not found");
        }
        const module = await import(pathToFileURL(path.join(directory, file)).href);
        lifecycle = Object.values(module).find(
          (value) =>
            typeof value === "function" && value.name === "getTrackedWorkerLifecycleSnapshot",
        );
        if (!lifecycle) {
          throw new Error("Built worker lifecycle export not found");
        }
      }
      process.send({
        channel: message.channel,
        id: message.id,
        snapshot: {
          maxRssKiB: resource.maxRSS,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
          totalCpuMs: (totalCpu.user + totalCpu.system) / 1000,
          workers: lifecycle(),
        },
      });
    } catch (error) {
      process.send({ channel: message.channel, id: message.id, error: String(error) });
    }
  };
  process.on("message", (message) => {
    void sample(message);
  });
  process.channel?.unref();
}
