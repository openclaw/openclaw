// Synthetic Gateway instrumentation: no query bindings, result rows, or task payloads.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, watch } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import {
  BroadcastChannel,
  getEnvironmentData,
  setEnvironmentData,
  threadId,
  workerData,
} from "node:worker_threads";

const configuration = getEnvironmentData("pg-footprint") ?? {
  output: process.env.PGFOOTPRINT_OUTPUT,
  channel: process.env.PGFOOTPRINT_CHANNEL,
};
const { output, channel } = configuration;
if (!output || !channel) {
  throw new Error("PG footprint preload requires its synthetic output and channel");
}
setEnvironmentData("pg-footprint", configuration);
const file = path.join(output, `workers-${process.pid}-${threadId}.jsonl`);
const record = (event) =>
  appendFileSync(
    file,
    `${JSON.stringify({ at: Date.now(), pid: process.pid, parentPid: process.ppid, threadId, ...event })}\n`,
  );
const phase = () => readFileSync(path.join(output, "phase"), "utf8").trim();
const children = createRequire(import.meta.url)("node:child_process");
const nativeSpawn = children.spawn;
const nativeFork = children.fork;
const profileArgs = process.execArgv.filter(
  (arg) => arg === "--cpu-prof" || arg.startsWith("--cpu-prof-dir="),
);
children.spawn = function (command, args, options) {
  const nodeChild = command === process.execPath;
  const child = nativeSpawn(
    command,
    nodeChild && profileArgs.length && Array.isArray(args)
      ? [
          ...profileArgs,
          "--import",
          path.resolve("scripts/lib/gateway-bench-cpu-profile.mjs"),
          ...args,
        ]
      : args,
    options,
  );
  if (nodeChild) {
    record({ type: "child-spawn", childPid: child.pid, phase: phase() });
  }
  return child;
};
children.fork = function (modulePath, args, options) {
  const forkOptions = (Array.isArray(args) ? options : args) ?? {};
  const execArgv = forkOptions.execArgv ?? process.execArgv;
  const child = nativeFork(modulePath, Array.isArray(args) ? args : [], {
    ...forkOptions,
    execArgv: profileArgs.length
      ? [
          ...execArgv,
          ...profileArgs.filter((arg) => !execArgv.includes(arg)),
          "--import",
          path.resolve("scripts/lib/gateway-bench-cpu-profile.mjs"),
        ]
      : execArgv,
  });
  record({ type: "child-spawn", childPid: child.pid, phase: phase() });
  return child;
};
const workers = createRequire(import.meta.url)("node:worker_threads");
const NativeWorker = workers.Worker;
workers.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      execArgv: execArgv.includes(import.meta.filename)
        ? execArgv
        : [...execArgv, "--import", import.meta.filename],
    });
    const workerId = this.threadId;
    record({ type: "spawn", workerId, script: String(filename), phase: phase() });
    const emit = this.emit;
    // Owners can remove their listeners after a reply, before native exit arrives.
    this.emit = function (event, ...args) {
      if (event === "exit") {
        record({ type: "exit", workerId, code: args[0], phase: phase() });
      }
      return Reflect.apply(emit, this, [event, ...args]);
    };
  }
};
syncBuiltinESMExports();

// Import the driver only where production already loads it; other isolates stay untouched.
const script = process.argv[1];
if (/[/\\]postgres-sync[/\\]bridge\.worker\.[cm]?[jt]s$/.test(script ?? "")) {
  const pg = createRequire(import.meta.url)("pg");
  const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  const schema = digest(workerData.schema);
  for (const method of ["connect", "end", "query"]) {
    const original = pg.Client.prototype[method];
    pg.Client.prototype[method] = function (...args) {
      if (method === "query") {
        record({
          type: "pg-query",
          schema,
          phase: phase(),
          sql: typeof args[0] === "string" ? args[0] : args[0].text,
        });
      } else {
        record({
          type: `pg-${method}`,
          schema,
          database: digest(this.connectionParameters.database),
          phase: phase(),
        });
      }
      return Reflect.apply(original, this, args);
    };
  }
}

const bus = new BroadcastChannel(channel);
bus.unref();
const sample = (label) => {
  record({
    type: "sample",
    sample: label,
    phase: phase(),
    memory: process.memoryUsage(),
    cpu: process.threadCpuUsage(),
    processCpu: threadId === 0 ? process.cpuUsage() : undefined,
  });
};
bus.addEventListener("message", ({ data }) => {
  if (data.type === "sample") {
    sample(data.sample);
  }
});
if (threadId === 0) {
  let previous;
  // Native resource children have their own IPC protocol and BroadcastChannel domain.
  watch(path.join(output, "sample-request"), { persistent: false }, () => {
    const label = readFileSync(path.join(output, "sample-request"), "utf8").trim();
    if (!label || label === previous) {
      return;
    }
    previous = label;
    sample(label);
    // Node BroadcastChannel has no targetOrigin argument.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    bus.postMessage({ type: "sample", sample: label });
  });
}
record({ type: "start", script });
