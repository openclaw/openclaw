// Isolated boot measurement only; propagates physical Worker counting through supervisors.
import { appendFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import workerThreads from "node:worker_threads";

const key = "openclaw.plugin-preparation-boot";
const output = workerThreads.getEnvironmentData(key) ?? process.env.OPENCLAW_PLUGIN_BOOT_OUTPUT;
if (!output) {
  throw new Error("Plugin boot preload requires its isolated output directory");
}
workerThreads.setEnvironmentData(key, output);
const events = path.join(output, `workers-${process.pid}-${workerThreads.threadId}.jsonl`);
const record = (event) =>
  appendFileSync(
    events,
    `${JSON.stringify({ atNs: String(process.hrtime.bigint()), ...event })}\n`,
  );
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    super(filename, {
      ...options,
      execArgv:
        options.execArgv === undefined
          ? undefined
          : [...options.execArgv, "--import", import.meta.url],
    });
    const id = this.threadId;
    const script = options.eval ? "eval" : path.basename(String(filename));
    record({ kind: "create", id, script });
    this.once("exit", (code) => record({ kind: "exit", id, script, code }));
  }
};
syncBuiltinESMExports();

if (workerThreads.isMainThread) {
  const snapshot = () => ({
    pid: process.pid,
    atNs: String(process.hrtime.bigint()),
    processCpuMicros: process.cpuUsage(),
    mainThreadCpuMicros: process.threadCpuUsage(),
    memoryBytes: process.memoryUsage(),
    maxRssKiB: process.resourceUsage().maxRSS,
    maxRssSource: "process.resourceUsage().maxRSS; OS high-water RSS, macOS equivalent to VmHWM",
  });
  process.on("message", (message) => {
    if (message?.channel === key && message.action === "sample") {
      process.send?.({ channel: key, snapshot: snapshot() });
    }
  });
  process.on("exit", () => {
    writeFileSync(path.join(output, "gateway-exit.json"), JSON.stringify(snapshot(), null, 2));
  });
}
