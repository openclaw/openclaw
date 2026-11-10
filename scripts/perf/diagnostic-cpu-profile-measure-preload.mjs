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
  let workload;
  let lastProfile;
  let measuring = false;
  let starts = [];
  let stops = 0;
  let stopMeasurements = [];
  let stalls = [];
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
      stalls.push({ at: now, delayMs });
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
          at,
          elapsedMs: performance.now() - at,
          cpuMs: (used.user + used.system) / 1000,
        });
      }
    }
  };
  const nativeStart = v8.startCpuProfile;
  v8.startCpuProfile = (options) => {
    const handle = measureStart("native", () => nativeStart(options));
    if (measuring) {
      workload?.start();
    }
    const stop = handle.stop.bind(handle);
    let stopped = false;
    handle.stop = () => {
      const firstStop = !stopped;
      if (measuring && firstStop) {
        stops++;
      }
      stopped = true;
      workload?.stop();
      const result = stop();
      if (measuring && workload && firstStop) {
        lastProfile = result;
      }
      return result;
    };
    return handle;
  };
  const inspectorPost = Object.getOwnPropertyDescriptor(inspector.Session.prototype, "post").value;
  inspector.Session.prototype.post = function (method, ...args) {
    if (method === "Profiler.start") {
      const result = measureStart("inspector", () => inspectorPost.call(this, method, ...args));
      if (measuring) {
        workload?.start();
      }
      return result;
    }
    if (measuring && method === "Profiler.stop") {
      stops++;
      workload?.stop();
      const callback = args.pop();
      args.push((error, result) => {
        if (workload) {
          lastProfile = result?.profile;
        }
        callback(error, result);
      });
      const at = performance.now();
      const cpu = process.threadCpuUsage();
      try {
        return inspectorPost.call(this, method, ...args);
      } finally {
        const used = process.threadCpuUsage(cpu);
        stopMeasurements.push({
          at,
          elapsedMs: performance.now() - at,
          cpuMs: (used.user + used.system) / 1000,
        });
      }
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
    stopMeasurements,
    stalls,
    stallCount,
    stallTotalMs,
    stallMaxMs,
    workload: workload?.snapshot(),
  });
  const server = createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      !["/start", "/stop", "/workload", "/profile"].includes(request.url)
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/workload") {
      try {
        const { createLargeGraphWorkload } =
          await import("./diagnostic-cpu-profile-measure-workload.mjs");
        workload ??= await createLargeGraphWorkload();
      } catch (error) {
        response.writeHead(500).end(String(error));
        return;
      }
    } else if (request.url === "/profile") {
      // Serialize only after telemetry stopped, so inspection adds no measured stalls.
      if (measuring) {
        response.writeHead(409).end();
        return;
      }
      const profile = lastProfile;
      lastProfile = undefined;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(profile ?? null));
      return;
    } else if (request.url === "/start") {
      starts = [];
      stopMeasurements = [];
      stalls = [];
      lastProfile = undefined;
      stops = stallCount = stallTotalMs = stallMaxMs = 0;
      previousTick = performance.now();
      measuring = true;
    } else {
      measuring = false;
      workload?.stop();
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(snapshot()));
  });
  server.listen(42360, "127.0.0.1");
  server.unref();
}
