// Synthetic update benchmark preload. No product hooks or operator-state access.
const fs = require("node:fs");
const path = require("node:path");
const { Session } = require("node:inspector");
const { syncBuiltinESMExports } = require("node:module");
const { deserialize } = require("node:v8");
const { threadId } = require("node:worker_threads");
const directory = process.env.SCHEMA_CROSSING_CHILD_OBSERVATIONS;
if (directory) {
  const file = path.join(directory, `${process.pid}-${threadId}.jsonl`);
  const log = (event) =>
    fs.appendFileSync(
      file,
      JSON.stringify({ at: Date.now(), pid: process.pid, threadId, ...event }) + "\n",
    );
  let readBytes = 0;
  const read = fs.readSync;
  fs.readSync = function (...args) {
    const bytes = Reflect.apply(read, this, args);
    readBytes += bytes;
    return bytes;
  };
  let active;
  process.on("message", (message) => {
    if (!message || !Array.isArray(message.args)) {
      return;
    }
    active = {
      id: message.id,
      mode: message.args[0],
      pathname: message.args[1],
      cpu: process.cpuUsage(),
      start: performance.now(),
      read: readBytes,
    };
    const command = message.operation?.command;
    log({
      kind: "request",
      ...active,
      operation:
        typeof command === "string" ? deserialize(Buffer.from(command, "base64")).type : undefined,
      artifactPreserving: message.auth?.artifactPreserving ?? message.operation?.artifactPreserving,
    });
  });
  if (process.send) {
    const send = process.send.bind(process);
    process.send = function (message, ...args) {
      if (active && message?.id === active.id) {
        log({
          kind: "reply",
          id: active.id,
          mode: active.mode,
          ms: performance.now() - active.start,
          cpu: process.cpuUsage(active.cpu),
          readBytes: readBytes - active.read,
          resultType: message.result?.type,
          ok: message.result?.ok,
        });
        if (message.result?.type === "complete" || message.result?.ok !== undefined) {
          active = undefined;
        }
      }
      return Reflect.apply(send, this, [message, ...args]);
    };
  }
  const root =
    threadId === 0 && process.argv.some((arg) => arg.endsWith("schema-crossing-measure.ts"));
  let inspector;
  if (!root && process.env.SCHEMA_CROSSING_CHILD_ALLOCATIONS === "1") {
    inspector = new Session();
    inspector.connect();
    inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 131072,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  syncBuiltinESMExports();
  log({ kind: "start", argv: process.argv });
  process.on("exit", () => {
    let allocatedBytes;
    inspector?.post("HeapProfiler.stopSampling", (error, result) => {
      if (error) {
        throw error;
      }
      allocatedBytes = result.profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    });
    inspector?.disconnect();
    log({
      kind: "exit",
      cpu: process.cpuUsage(),
      readBytes,
      allocatedBytes,
    });
  });
}
