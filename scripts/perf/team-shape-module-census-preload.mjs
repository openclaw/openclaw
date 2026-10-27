/**
 * Pass --gateway-preload "$PWD/scripts/perf/team-shape-module-census-preload.mjs"
 * to team-shape-stress.ts. Captures module-census.json after each measured window.
 * Does not enable coverage or Debugger during timing. Require the output file
 * before interpreting a run; the census uses the owned Gateway's private IPC.
 */
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import "./main-module-census-preload.mjs";

if (isMainThread) {
  process.on("message", (message) => {
    if (message?.channel === "team-shape-stress" && message.action === "stop") {
      // Telemetry finishes asynchronously; the stop request is not its boundary.
      const send = process.send.bind(process);
      process.send = (...args) => {
        const reply = args[0];
        const stopped = reply?.channel === "team-shape-stress" && reply.action === "stop";
        if (stopped) {
          process.send = send;
        }
        const result = send(...args);
        if (stopped && reply.ok) {
          queueMicrotask(() => {
            process.emit("message", {
              channel: "main-module-census",
              action: "capture",
              id: "team-stress-census",
              output: path.join(message.output, "module-census.json"),
            });
          });
        }
        return result;
      };
    }
  });
}
