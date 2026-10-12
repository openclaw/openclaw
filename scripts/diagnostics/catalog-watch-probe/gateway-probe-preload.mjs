import fs from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";

const output = process.env.CATALOG_PROBE_OUTPUT;
if (output) {
  const file = path.join(output, `metrics-${process.pid}-${threadId}.jsonl`);
  const emit = (kind, data) =>
    fs.appendFileSync(
      file,
      JSON.stringify({
        at: Date.now(),
        pid: process.pid,
        threadId,
        kind,
        ...data,
      }) + "\n",
    );
  const counters = { watches: 0, invalidations: 0, health: {}, reasons: {}, workers: {} };
  globalThis[Symbol.for("openclaw.catalogWatchProbe")] = (original, authority, options) => {
    const id = ++counters.watches;
    emit("watch", {
      id,
      root: authority.rootDir,
      scopes: options.scopes,
      persistent: options.persistent,
    });
    let details = 0;
    let controlDetails = 0;
    return original(authority, {
      ...options,
      onHealth(event) {
        counters.health[event.state] = (counters.health[event.state] ?? 0) + 1;
        if (event.state === "unavailable" || event.state === "polling") {
          emit("health", { id, event });
        }
        return options.onHealth?.(event);
      },
      onInvalidate(event) {
        counters.invalidations++;
        counters.reasons[event.reason] = (counters.reasons[event.reason] ?? 0) + 1;
        const selectedControl = event.changes?.some((change) =>
          change.path.replaceAll("\\", "/").endsWith("probe/SKILL.md"),
        );
        if (++details <= 30 || (selectedControl && ++controlDetails <= 10)) {
          emit("invalidate", { id, event });
        }
        return options.onInvalidate?.(event);
      },
    });
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (specifier !== "@openclaw/fs-safe/watch") {
        return result;
      }
      const source = `export * from ${JSON.stringify(result.url)};
import { watch as original } from ${JSON.stringify(result.url)};
export function watch(authority, options) { return globalThis[Symbol.for("openclaw.catalogWatchProbe")](original, authority, options); }`;
      return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    },
  });
  if (isMainThread) {
    const workerThreads = createRequire(import.meta.url)("node:worker_threads");
    const OriginalWorker = workerThreads.Worker;
    workerThreads.Worker = class extends OriginalWorker {
      constructor(filename, options) {
        super(filename, options);
        const name = options?.eval ? "<eval>" : path.basename(String(filename));
        const count = (counters.workers[name] ??= { started: 0, exited: 0 });
        count.started++;
        emit("worker-start", { name, workerId: this.threadId });
        this.once("exit", (code) => {
          count.exited++;
          emit("worker-exit", { name, code });
        });
      }
    };
    syncBuiltinESMExports();
  }
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let priorCpu = process.cpuUsage();
  let priorElu = performance.eventLoopUtilization();
  let priorTime = performance.now();
  emit("start", { node: process.version, platform: process.platform, main: isMainThread });
  setInterval(() => {
    const now = performance.now();
    const currentCpu = process.cpuUsage();
    const currentElu = performance.eventLoopUtilization();
    const elapsedMs = now - priorTime;
    emit("sample", {
      elapsedMs,
      cpuCores:
        (currentCpu.user - priorCpu.user + (currentCpu.system - priorCpu.system)) /
        (elapsedMs * 1000),
      elu: performance.eventLoopUtilization(currentElu, priorElu).utilization,
      delayP99Ms: delay.percentile(99) / 1e6,
      delayMaxMs: delay.max / 1e6,
      rss: process.memoryUsage().rss,
      counters,
    });
    priorTime = now;
    priorCpu = currentCpu;
    priorElu = currentElu;
    delay.reset();
  }, 5000).unref();
}
