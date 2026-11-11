// Benchmark-only instrumentation; never loaded by a normal Gateway.
import { createHook } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { BroadcastChannel, isMainThread, threadId } from "node:worker_threads";

const channelName = process.env.OPENCLAW_IDLE_MEASURE_CHANNEL;
if (!channelName) {
  throw new Error("Missing private idle measurement channel");
}
const bus = new BroadcastChannel(channelName);
bus.unref();
const workers = createRequire(import.meta.url)("node:worker_threads");
const NativeWorker = workers.Worker;
const watchWorkers = new Set();
let watchNotifications = 0;
if (isMainThread && process.env.OPENCLAW_IDLE_MEASURE_WATCHER_FAILURE === "1") {
  const owner = new URL("../../src/config/source-file.ts", import.meta.url).href;
  const notification = Symbol.for("openclaw.bench.config-notification");
  globalThis[notification] = (notify) => () => {
    watchNotifications++;
    notify();
  };
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== owner) {
        return loaded;
      }
      const source = readFileSync(new URL(url), "utf8");
      const anchor = "  type Watcher = {";
      if (source.split(anchor).length !== 2) {
        throw new Error("Config watcher instrumentation anchor changed");
      }
      return {
        ...loaded,
        format: "module-typescript",
        source: source.replace(
          anchor,
          `  opts.onChange = globalThis[Symbol.for("openclaw.bench.config-notification")](opts.onChange);\n${anchor}`,
        ),
      };
    },
  });
}
const profileArgs = process.execArgv.filter(
  (arg) =>
    arg === "--cpu-prof" ||
    arg.startsWith("--cpu-prof-dir=") ||
    arg.startsWith("--cpu-prof-interval="),
);
workers.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      // Some owners deliberately filter worker environments; retain our private channel.
      env:
        options.env && typeof options.env === "object"
          ? {
              ...options.env,
              OPENCLAW_IDLE_MEASURE_CHANNEL: channelName,
              OPENCLAW_IDLE_MEASURE_TIMERS: process.env.OPENCLAW_IDLE_MEASURE_TIMERS,
            }
          : options.env,
      execArgv: [
        ...execArgv,
        ...profileArgs.filter((arg) => !execArgv.includes(arg)),
        "--import",
        fileURLToPath(import.meta.url),
      ],
    });
    if (isMainThread && String(filename).endsWith("/watch-io-worker.js")) {
      watchWorkers.add(this);
      this.once("exit", () => watchWorkers.delete(this));
    }
  }
};
syncBuiltinESMExports();

const timers = new Map();
const counts = new Map();
let enabled = false;
let before;
let current;
if (process.env.OPENCLAW_IDLE_MEASURE_TIMERS === "1") {
  createHook({
    init(id, type) {
      if (type !== "Timeout" && type !== "Immediate") {
        return;
      }
      const source =
        new Error().stack
          ?.split("\n")
          .filter(
            (line) =>
              !line.includes("node:") &&
              !line.includes("idle-gateway-measure-preload") &&
              line.trim() !== "Error",
          )
          .slice(0, 6)
          .join("\n") ?? "unknown";
      timers.set(id, `${type}: ${source}`);
    },
    before(id) {
      const source = timers.get(id);
      if (!enabled || !source) {
        return;
      }
      current = counts.get(source) ?? { source, callbacks: 0, cpuUs: 0 };
      counts.set(source, current);
      current.callbacks++;
      before = process.threadCpuUsage();
    },
    after(id) {
      if (!current || !timers.has(id)) {
        return;
      }
      const used = process.threadCpuUsage(before);
      current.cpuUs += used.user + used.system;
      current = undefined;
    },
    destroy(id) {
      timers.delete(id);
    },
  }).enable();
}

function snapshot() {
  return {
    threadId,
    at: performance.now(),
    cpu: process.threadCpuUsage(),
    totalCpu: isMainThread ? process.cpuUsage() : undefined,
    memory: process.memoryUsage(),
    // Loop iterations/events are a wakeup proxy, not a count of OS wakeup syscalls.
    uv: performance.nodeTiming.uvMetricsInfo,
    timers: Array.from(counts.values(), ({ source, callbacks, cpuUs }) => ({
      source,
      callbacks,
      cpuUs,
    })),
  };
}
// Node BroadcastChannel has no target-origin parameter.
const broadcast = (message) => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  bus.postMessage(message);
};
bus.addEventListener("message", ({ data }) => {
  if (data.action === "enable") {
    enabled = true;
  }
  if (data.action === "sample") {
    broadcast({ action: "result", id: data.id, row: snapshot() });
  }
  if (isMainThread && data.action === "join" && enabled) {
    broadcast({ action: "enable" });
  }
});
if (isMainThread) {
  if (!process.send) {
    throw new Error("Idle measurement requires a private IPC descriptor");
  }
  process.on("message", (message) => {
    if (message?.channel !== channelName) {
      return;
    }
    if (message.action === "enable") {
      enabled = true;
      broadcast({ action: "enable" });
    }
    if (message.action === "sample") {
      process.send?.({ channel: channelName, id: message.id, row: snapshot() });
      broadcast({ action: "sample", id: message.id });
    }
    if (message.action === "watcher-count") {
      process.send?.({ channel: channelName, id: message.id, watchNotifications });
    }
    if (message.action === "watcher-fail") {
      const worker = [...watchWorkers][0];
      if (!worker) {
        process.send?.({ channel: channelName, id: message.id, error: "No watch worker" });
        return;
      }
      watchNotifications = 0;
      void worker.terminate().then(() => {
        process.send?.({ channel: channelName, id: message.id, terminated: true });
      });
    }
  });
  bus.addEventListener("message", ({ data }) => {
    if (data.action === "result") {
      process.send?.({ channel: channelName, ...data });
    }
  });
  process.channel?.unref();
} else {
  broadcast({ action: "join" });
}
