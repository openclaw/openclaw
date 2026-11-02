import { createHash } from "node:crypto";
// Private benchmark instrumentation; opt-in setup retains only synthetic Cron binding metadata.
import { channel } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const channelName = "gateway-ui-rpc-measure";
const port = Number(process.env.OPENCLAW_BENCH_RPC_PORT);
// execArgv reaches workers and nested children; only the controller's direct CLI owns capture.
if (
  isMainThread &&
  process.send &&
  Number.isInteger(port) &&
  port >= 40000 &&
  process.ppid === Number(process.env.OPENCLAW_BENCH_RPC_PARENT) &&
  process.argv[1] === process.env.OPENCLAW_BENCH_RPC_ENTRY
) {
  installObserver();
}
function installObserver() {
  let active;
  let inspector;
  const numericFields = [
    "durationMs",
    "elapsedMs",
    "queueWaitMs",
    "admissionMs",
    "responseBytes",
    "threadCpuMs",
    "queueMs",
    "preparationMs",
    "hostWaitMs",
    "runMs",
    "transferMs",
    "prepareThreadCpuMs",
    "rowThreadCpuMs",
    "responseThreadCpuMs",
    "prepareSyncMs",
    "rowSyncMs",
    "yieldWaitMs",
    "selectedRowCount",
    "materializedRowCount",
    "reusedRowCount",
  ];
  for (const source of [
    "openclaw.gateway.rpc",
    "openclaw.worker.task",
    "openclaw.session.list",
    "openclaw.gateway.request.stages",
  ]) {
    channel(source).subscribe((raw) => {
      if (!active || !raw || typeof raw !== "object") {
        return;
      }
      const rpc = active.rpc;
      if (source === "openclaw.gateway.rpc" && rpc && raw.method === rpc.method) {
        // Serial benchmark calls have no request ID in this diagnostic channel.
        if (raw.phase === "received" && ++rpc.receivedCount === 1) {
          rpc.processStart = process.cpuUsage();
          rpc.threadStart = process.threadCpuUsage();
        } else if (
          raw.phase === "response" &&
          raw.firstResponse === true &&
          rpc.receivedCount === 1 &&
          !rpc.cpu
        ) {
          const processCpu = process.cpuUsage(rpc.processStart);
          const threadCpu = process.threadCpuUsage(rpc.threadStart);
          rpc.cpu = {
            rpcProcessCpuMs: (processCpu.user + processCpu.system) / 1000,
            rpcMainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
          };
        }
      }
      const event = { source };
      for (const key of [
        "method",
        "operation",
        "phase",
        "outcome",
        "kind",
        "requestClass",
        "workerClass",
        "worker",
      ]) {
        if (typeof raw[key] === "string") {
          event[key] = raw[key];
        }
      }
      if (typeof raw.firstResponse === "boolean") {
        event.firstResponse = raw.firstResponse;
      }
      for (const key of numericFields) {
        if (typeof raw[key] === "number" && Number.isFinite(raw[key])) {
          event[key] = raw[key];
        }
      }
      if (raw.phaseDurationsMs && typeof raw.phaseDurationsMs === "object") {
        event.phaseDurationsMs = Object.fromEntries(
          Object.entries(raw.phaseDurationsMs).filter(
            ([, value]) => typeof value === "number" && Number.isFinite(value),
          ),
        );
      }
      active.events.push(event);
    });
  }
  const stringify = JSON.stringify;
  const countedStringify = function (...args) {
    if (!active) {
      return Reflect.apply(stringify, JSON, args);
    }
    const started = performance.now();
    try {
      return Reflect.apply(stringify, JSON, args);
    } finally {
      active.jsonStringifyMs += performance.now() - started;
      active.jsonStringifyCount++;
    }
  };
  // Captured for restoration; Reflect.apply preserves the socket receiver.
  const write = Socket.prototype.write;
  const countedWrite = function (...args) {
    if (!active || this.localPort !== port) {
      return Reflect.apply(write, this, args);
    }
    const started = performance.now();
    try {
      return Reflect.apply(write, this, args);
    } finally {
      active.socketWriteMs += performance.now() - started;
      active.socketWriteCount++;
      const data = args[0];
      active.socketWriteBytes +=
        typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    }
  };

  let controls = Promise.resolve();
  process.on("message", (message) => {
    if (message?.channel !== channelName) {
      return;
    }
    controls = controls
      .then(async () => {
        let result;
        if (message.action === "cron-publication-setup") {
          if (active || inspector) {
            throw new Error("Cron fixture inspection must stay outside timing and profiles");
          }
          const checkout = path.dirname(path.dirname(process.env.OPENCLAW_BENCH_RPC_ENTRY));
          const owner = (file) => import(pathToFileURL(path.join(checkout, "src", file)).href);
          const [
            { loadCronJobsStoreWithConfigJobsReadOnly },
            { resolveCronJobSessionBindings },
            config,
          ] = await Promise.all([
            owner("cron/store/read-only.ts"),
            owner("cron/job-session-bindings.ts"),
            owner("config/config.ts"),
          ]);
          const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(message.storePath);
          const jobs = loaded.store.jobs;
          if (
            loaded.invalidConfigRows.length ||
            jobs.length !== 1000 ||
            jobs.some(
              (job) =>
                job.enabled !== false || job.agentId !== "main" || job.state.nextRunAtMs != null,
            )
          ) {
            throw new Error("Cron publication fixture requires 1,000 canonical disabled main jobs");
          }
          const cfg = config.getRuntimeConfig();
          const bindings = jobs.map((job) => ({
            id: job.id,
            keys: [...resolveCronJobSessionBindings(job, { cfg, defaultAgentId: "main" }).keys()],
          }));
          const common = bindings[0].keys.filter((key) =>
            bindings.every((binding) => binding.keys.includes(key)),
          );
          if (common.length !== 1 || new Set(jobs.map((job) => job.id)).size !== jobs.length) {
            throw new Error("Cron publication fixture needs one shared binding and unique job IDs");
          }
          const uniqueKey = (binding) => {
            const keys = binding.keys.filter((key) => key !== common[0]);
            if (
              keys.length !== 1 ||
              bindings.filter((other) => other.keys.includes(keys[0])).length !== 1
            ) {
              throw new Error("Cron publication endpoint needs a unique execution binding");
            }
            return keys[0];
          };
          result = {
            jobIds: bindings.map((binding) => binding.id),
            sortedJobIds: bindings
              .map((binding) => binding.id)
              .toSorted((a, b) => a.localeCompare(b)),
            sharedKey: common[0],
            earlyKey: uniqueKey(bindings[0]),
            lateKey: uniqueKey(bindings.at(-1)),
            contentSha256: createHash("sha256").update(stringify(jobs)).digest("hex"),
          };
        } else if (message.action === "begin") {
          if (active) {
            throw new Error("overlapping RPC measurement windows");
          }
          const countOps = message.countOps !== false;
          JSON.stringify = countOps ? countedStringify : stringify;
          Socket.prototype.write = countOps ? countedWrite : write;
          active = {
            events: [],
            rpc:
              typeof message.method === "string"
                ? { method: message.method, receivedCount: 0 }
                : undefined,
            ...(countOps
              ? {
                  jsonStringifyMs: 0,
                  jsonStringifyCount: 0,
                  socketWriteMs: 0,
                  socketWriteCount: 0,
                  socketWriteBytes: 0,
                }
              : {}),
            startedAt: performance.now(),
            processStart: process.cpuUsage(),
            threadStart: process.threadCpuUsage(),
          };
        } else if (message.action === "end") {
          if (!active) {
            throw new Error("no active RPC measurement window");
          }
          const captured = active;
          active = undefined;
          JSON.stringify = stringify;
          Socket.prototype.write = write;
          const processCpu = process.cpuUsage(captured.processStart);
          const threadCpu = process.threadCpuUsage(captured.threadStart);
          const {
            processStart: _processStart,
            threadStart: _threadStart,
            startedAt,
            rpc,
            ...metrics
          } = captured;
          result = {
            ...metrics,
            windowMs: performance.now() - startedAt,
            processCpuMs: (processCpu.user + processCpu.system) / 1000,
            mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
            ...(rpc
              ? {
                  rpcReceivedCount: rpc.receivedCount,
                  ...(rpc.receivedCount === 1 ? rpc.cpu : {}),
                }
              : {}),
          };
        } else if (message.action === "profile-start") {
          inspector = new Session();
          inspector.connect();
          if (message.allocations) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 32768,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          } else {
            await inspector.post("Profiler.enable");
            await inspector.post("Profiler.setSamplingInterval", { interval: 1000 });
            await inspector.post("Profiler.start");
          }
        } else if (message.action === "profile-stop") {
          if (!inspector) {
            throw new Error("no profile active");
          }
          const { profile } = await inspector.post(
            message.allocations ? "HeapProfiler.stopSampling" : "Profiler.stop",
          );
          writeFileSync(message.path, stringify(profile), { mode: 0o600 });
          inspector.disconnect();
          inspector = undefined;
        } else {
          throw new Error(`unknown measurement control: ${message.action}`);
        }
        process.send({ channel: channelName, id: message.id, result });
      })
      .catch((/** @type {unknown} */ error) => {
        process.send({
          channel: channelName,
          id: message.id,
          error: error instanceof Error ? error.message : "Unknown benchmark control failure",
        });
      });
  });
  process.once("disconnect", () => inspector?.disconnect());
  process.channel?.unref();
}
