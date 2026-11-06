// Runtime exit-listener probe preload: each isolate owns its process emitter, even with a shared PID.
import { defaultMaxListeners } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { isMainThread, threadId, BroadcastChannel } from "node:worker_threads";

if (process.env.OPENCLAW_EXIT_LISTENER_TRACE_DIR) {
  const file = path.join(
    process.env.OPENCLAW_EXIT_LISTENER_TRACE_DIR,
    `${process.pid}-${threadId}.jsonl`,
  );
  const started = performance.now();
  const registrationStacks = new WeakMap();
  const record = (type, fields = {}) =>
    appendFileSync(
      file,
      JSON.stringify({
        type,
        pid: process.pid,
        threadId,
        isMainThread,
        at: Date.now(),
        elapsedMs: performance.now() - started,
        count: process.listenerCount("exit"),
        defaultLimit: defaultMaxListeners,
        limit: process.getMaxListeners(),
        ...(isMainThread ? { cpu: process.cpuUsage(), memory: process.memoryUsage() } : {}),
        ...fields,
      }) + "\n",
    );
  record("isolate");
  process.on("newListener", (event, listener) => {
    if (event !== "exit") {
      return;
    }
    const previous = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const stack = new Error("exit listener registration").stack;
    Error.stackTraceLimit = previous;
    registrationStacks.set(listener, stack);
    record("register", { name: listener.name, count: process.listenerCount("exit") + 1, stack });
  });
  process.on("removeListener", (event, listener) => {
    if (event === "exit") {
      record("remove", { name: (listener.listener ?? listener).name });
    }
  });
  process.on("warning", (warning) =>
    record("warning", {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    }),
  );
  const channel = new BroadcastChannel("openclaw-exit-listeners-proof");
  const checkpoint = (phase) =>
    record("checkpoint", {
      phase,
      listeners: process
        .listeners("exit")
        .map((listener) => ({ name: listener.name, stack: registrationStacks.get(listener) })),
    });
  channel.addEventListener("message", ({ data }) => checkpoint(data));
  channel.unref();
  if (
    isMainThread &&
    process.send &&
    path.resolve(process.argv[1] ?? "") === process.env.OPENCLAW_EXIT_LISTENER_TRACE_ENTRY
  ) {
    let profiler;
    const handleMessage = async (message) => {
      if (message?.type === "exit-listeners:checkpoint") {
        try {
          if (process.env.OPENCLAW_EXIT_LISTENER_PROFILE === "1") {
            if (message.phase === "ready") {
              profiler = new Session();
              profiler.connect();
              await profiler.post("Profiler.enable");
              await profiler.post("Profiler.start");
              await profiler.post("HeapProfiler.startSampling", {
                samplingInterval: 32768,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            } else if (message.phase === "complete" && profiler) {
              try {
                const cpu = await profiler.post("Profiler.stop");
                const allocations = await profiler.post("HeapProfiler.stopSampling");
                const output = path.dirname(process.env.OPENCLAW_EXIT_LISTENER_TRACE_DIR);
                writeFileSync(path.join(output, "cpu.cpuprofile"), JSON.stringify(cpu.profile));
                writeFileSync(
                  path.join(output, "allocations.heapprofile"),
                  JSON.stringify(allocations.profile),
                );
              } finally {
                profiler.disconnect();
              }
            }
          }
          checkpoint(message.phase);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node BroadcastChannel has no targetOrigin.
          channel.postMessage(message.phase);
          process.send({ type: "exit-listeners:checkpoint:ack", phase: message.phase });
        } catch (error) {
          process.send({
            type: "exit-listeners:checkpoint:ack",
            phase: message.phase,
            error: String(error),
          });
        }
      }
    };
    process.on("message", (message) => {
      void handleMessage(message);
    });
    process.channel?.unref();
  }
}
