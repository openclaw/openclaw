/**
 * Diagnostic-only script inventory at the Gateway's first HTTP bind.
 * Use a --gateway-runtime wrapper with bench-gateway-startup.ts that executes:
 * node --import 'file:///absolute/scripts/perf/bootstrap-import-preload.mjs?output=/absolute/capture.json' "$@"
 * Add the benchmark's --cpu-prof-dir separately for CPU attribution. Compare
 * uninstrumented alternating startup runs for latency; Debugger changes timing.
 * The benchmark owns isolated synthetic state and a loopback port >=40000.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Server } from "node:http";
import { Session } from "node:inspector";
import { Server as NetServer } from "node:net";
import { loadavg } from "node:os";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.argv[2] === "gateway") {
  const output = new URL(import.meta.url).searchParams.get("output");
  assert.ok(output, "Specify ?output=/absolute/capture.json");
  const inspector = new Session();
  inspector.connect();
  const scripts = new Set();
  inspector.on("Debugger.scriptParsed", ({ params }) => {
    if (params.url) {
      scripts.add(params.url);
    }
  });
  inspector.post("Debugger.enable");
  Server.prototype.listen = function (...args) {
    // HTTP Server inherits listen from net.Server; remove this one-shot override first.
    delete Server.prototype.listen;
    const atListen = {
      elapsedMs: performance.now(),
      cpu: process.threadCpuUsage(),
      memory: process.memoryUsage(),
      hostLoad: loadavg(),
      scripts: [...scripts],
    };
    inspector.disconnect();
    this.once("listening", () => {
      writeFileSync(
        output,
        `${JSON.stringify({ ...atListen, address: this.address() }, null, 2)}\n`,
      );
    });
    return NetServer.prototype.listen.apply(this, args);
  };
}
