// Synthetic, loopback-only Gateway telemetry for diagnostic-cpu-profile-measure.mts.
// Pass this exact path as transcript-broadcast-measure.ts --gateway-preload.
// This listener is benchmark instrumentation, never a production Gateway service.
import { createServer } from "node:http";
import inspector from "node:inspector";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import v8 from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  let measuring = false;
  let starts = [];
  let stops = 0;
  let stallCount = 0;
  let stallTotalMs = 0;
  let stallMaxMs = 0;
  let previousTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const delayMs = Math.max(0, now - previousTick - 10);
    if (measuring && delayMs >= 50) {
      stallCount++;
      stallTotalMs += delayMs;
      stallMaxMs = Math.max(stallMaxMs, delayMs);
    }
    previousTick = now;
  }, 10);
  timer.unref();
  const measureStart = (backend, operation) => {
    if (!measuring) {
      return operation();
    }
    const at = performance.now();
    const cpu = process.threadCpuUsage();
    try {
      return operation();
    } finally {
      if (measuring) {
        const used = process.threadCpuUsage(cpu);
        starts.push({
          backend,
          elapsedMs: performance.now() - at,
          cpuMs: (used.user + used.system) / 1000,
        });
      }
    }
  };
  const nativeStart = v8.startCpuProfile;
  v8.startCpuProfile = (options) => {
    const handle = measureStart("native", () => nativeStart(options));
    const stop = handle.stop.bind(handle);
    let stopped = false;
    handle.stop = () => {
      if (measuring && !stopped) {
        stops++;
      }
      stopped = true;
      return stop();
    };
    return handle;
  };
  const inspectorPost = Object.getOwnPropertyDescriptor(inspector.Session.prototype, "post").value;
  inspector.Session.prototype.post = function (method, ...args) {
    if (method === "Profiler.start") {
      return measureStart("inspector", () => inspectorPost.call(this, method, ...args));
    }
    if (measuring && method === "Profiler.stop") {
      stops++;
    }
    return inspectorPost.call(this, method, ...args);
  };
  syncBuiltinESMExports();
  const snapshot = () => ({
    at: performance.now(),
    node: process.version,
    cpu: process.cpuUsage(),
    thread: process.threadCpuUsage(),
    memory: process.memoryUsage(),
    load: loadavg(),
    starts,
    stops,
    stallCount,
    stallTotalMs,
    stallMaxMs,
  });
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !["/start", "/stop"].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/start") {
      starts = [];
      stops = stallCount = stallTotalMs = stallMaxMs = 0;
      previousTick = performance.now();
      measuring = true;
    } else {
      measuring = false;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(snapshot()));
  });
  server.listen(42360, "127.0.0.1");
  server.unref();
}
