// Transparent native-I/O observation for bench-session-source-notifications.mjs.
// Diagnostic native-call timings exclude JavaScript identity-check and stack-capture cost.
import fs from "node:fs";
import inspector from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send && process.env.SOURCE_PROOF_ROOT) {
  const trace = process.env.SOURCE_PROOF_DIAGNOSTIC === "1";
  const root = path.resolve(process.env.SOURCE_PROOF_ROOT).toLowerCase();
  const aliases = path.join(root, "aliases");
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let enabled = false;
  let activeEvent;
  let stats;
  let cpu;
  let threadCpu;
  let started;
  let profile;
  function reset() {
    stats = {
      events: {},
      source: { realpath: 0, stat: 0, ms: 0, callbackOps: 0 },
      stateFs: { realpath: 0, stat: 0 },
      callbacks: { count: 0, ms: 0, maxMs: 0 },
      stacks: [],
    };
    cpu = process.cpuUsage();
    threadCpu = process.threadCpuUsage();
    started = performance.now();
    histogram.reset();
    enabled = true;
  }
  if (trace) {
    const watch = fs.watch;
    fs.watch = function (...args) {
      if (!trace) {
        return watch.apply(this, args);
      }
      const watched = path.resolve(String(args[0])).toLowerCase();
      const callbackIndex = args.findLastIndex((arg) => typeof arg === "function");
      if (callbackIndex >= 0) {
        const listener = args[callbackIndex];
        args[callbackIndex] = function (...eventArgs) {
          const [event, filename] = eventArgs;
          const previous = activeEvent;
          const category =
            watched === aliases ? "alias-parent" : watched.startsWith(root) ? "fixture" : "other";
          const label = `${category}:${event}:${filename === undefined || filename === null ? "unnamed" : "named"}`;
          activeEvent = label;
          const begin = performance.now();
          if (enabled) {
            stats.events[label] = (stats.events[label] ?? 0) + 1;
          }
          try {
            return listener.apply(this, eventArgs);
          } finally {
            if (enabled) {
              const elapsed = performance.now() - begin;
              stats.callbacks.count++;
              stats.callbacks.ms += elapsed;
              stats.callbacks.maxMs = Math.max(stats.callbacks.maxMs, elapsed);
            }
            activeEvent = previous;
          }
        };
      }
      return watch.apply(this, args);
    };
    function observe(original, kind) {
      return function (...args) {
        if (!trace || !enabled || !String(args[0]).toLowerCase().startsWith(root)) {
          return original.apply(this, args);
        }
        stats.stateFs[kind]++;
        const stack = new Error().stack ?? "";
        const source = stack.includes("memo.pathsCurrent");
        if (source && stats.stacks.length < 3) {
          stats.stacks.push(stack.replaceAll(root, "<fixture>"));
        }
        const begin = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          if (source) {
            stats.source[kind]++;
            stats.source.ms += performance.now() - begin;
            if (activeEvent) {
              stats.source.callbackOps++;
            }
          }
        }
      };
    }
    fs.realpathSync.native = observe(fs.realpathSync.native, "realpath");
    fs.statSync = observe(fs.statSync, "stat");
    syncBuiltinESMExports();
  }
  process.on("message", async (message) => {
    if (message?.channel !== "source-proof") {
      return;
    }
    try {
      if (message.action === "reset") {
        reset();
      } else if (message.action === "profile-start") {
        profile = new inspector.Session();
        profile.connect();
        await profile.post("Profiler.enable");
        await profile.post("Profiler.start");
      }
      let result;
      if (message.action === "profile-stop") {
        result = await profile.post("Profiler.stop");
        profile.disconnect();
        profile = undefined;
      } else if (message.action === "snapshot") {
        enabled = false;
        result = {
          ...stats,
          cpu: process.cpuUsage(cpu),
          threadCpu: process.threadCpuUsage(threadCpu),
          elapsedMs: performance.now() - started,
          loopDelay: {
            meanMs: histogram.mean / 1e6,
            p95Ms: histogram.percentile(95) / 1e6,
            maxMs: histogram.max / 1e6,
          },
          memory: process.memoryUsage(),
        };
      }
      process.send({ channel: "source-proof", id: message.id, result });
    } catch (error) {
      process.send({ channel: "source-proof", id: message.id, error: String(error) });
    }
  });
}
