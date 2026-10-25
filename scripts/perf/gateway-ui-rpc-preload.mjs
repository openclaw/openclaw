// Private benchmark instrumentation. No payload, config value, or credential is retained.
import { channel } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
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
        if (message.action === "begin") {
          if (active) {
            throw new Error("overlapping RPC measurement windows");
          }
          const countOps = message.countOps !== false;
          JSON.stringify = countOps ? countedStringify : stringify;
          Socket.prototype.write = countOps ? countedWrite : write;
          active = {
            events: [],
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
            ...metrics
          } = captured;
          result = {
            ...metrics,
            windowMs: performance.now() - startedAt,
            processCpuMs: (processCpu.user + processCpu.system) / 1000,
            mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
          };
        } else if (message.action === "profile-start") {
          inspector = new Session();
          inspector.connect();
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.setSamplingInterval", { interval: 1000 });
          await inspector.post("Profiler.start");
        } else if (message.action === "profile-stop") {
          if (!inspector) {
            throw new Error("no CPU profile active");
          }
          const { profile } = await inspector.post("Profiler.stop");
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
