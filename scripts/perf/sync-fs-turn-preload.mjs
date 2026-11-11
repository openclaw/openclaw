// Local synthetic Gateway census. No product hooks, paths, arguments or file contents are logged.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import { Session } from "node:inspector/promises";
import Module, { createRequire, syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.env.OPENCLAW_SYNC_FS_PROBE_PORT) {
  const port = Number(process.env.OPENCLAW_SYNC_FS_PROBE_PORT);
  delete process.env.OPENCLAW_SYNC_FS_PROBE_PORT;
  assert(process.env.OPENCLAW_STATE_DIR, "Use an isolated synthetic state directory");
  Error.stackTraceLimit = 30;
  let active;
  let nested = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const loop = monitorEventLoopDelay({ resolution: 1 });
  const records = new Map();
  const timingOnly = process.env.OPENCLAW_SYNC_FS_PROBE_MODE === "timing";
  let inspector;
  function observe(name, invoke) {
    if (!active || nested) {
      return invoke();
    }
    const stack = new Error().stack.split("\n").slice(3).join("\n");
    const key = `${name}\n${stack}`;
    let row = records.get(key);
    if (!row) {
      row = { name, stack, count: 0, totalMs: 0, maxMs: 0 };
      records.set(key, row);
    }
    const start = performance.now();
    nested++;
    try {
      if (active.delayMs && !active.injected && stack.includes(active.match)) {
        active.injected = true;
        Atomics.wait(sleeper, 0, 0, active.delayMs);
      }
      return invoke();
    } finally {
      nested--;
      const elapsed = performance.now() - start;
      row.count++;
      row.totalMs += elapsed;
      row.maxMs = Math.max(row.maxMs, elapsed);
    }
  }
  function wrap(owner, name, label) {
    if (timingOnly) {
      return;
    }
    const original = owner[name];
    owner[name] = new Proxy(original, {
      apply(target, receiver, args) {
        return observe(label, () => Reflect.apply(target, receiver, args));
      },
      construct(target, args, newTarget) {
        return observe(label, () => Reflect.construct(target, args, newTarget));
      },
    });
  }
  for (const name of Object.keys(fs)) {
    if (name.endsWith("Sync") && typeof fs[name] === "function") {
      wrap(fs, name, `fs.${name}`);
    }
  }
  const readFile = fsp.readFile;
  if (!timingOnly) {
    fsp.readFile = async function (...args) {
      const sample = active;
      if (sample?.delayMs && !sample.injected && new Error().stack.includes(sample.match)) {
        sample.injected = true;
        await delay(sample.delayMs);
      }
      return Reflect.apply(readFile, this, args);
    };
  }
  wrap(fs.realpathSync, "native", "fs.realpathSync.native");
  const require = createRequire(import.meta.url);
  wrap(require("node:sqlite"), "DatabaseSync", "sqlite.DatabaseSync");
  // fs-safe native calls bypass node:fs. Record native entry points separately;
  // Async-suffixed methods enqueue work and are not synchronous syscall evidence.
  // eslint-disable-next-line no-underscore-dangle -- Intercept native addon exports before fs-safe captures them.
  const load = Module._load;
  const instrumented = new WeakSet();
  // eslint-disable-next-line no-underscore-dangle -- This opt-in census must observe native calls that bypass node:fs.
  Module._load = function (specifier, ...args) {
    const exports = Reflect.apply(load, this, [specifier, ...args]);
    if (
      /^@openclaw\/fs-safe-(?:darwin|linux|win32|freebsd)/u.test(specifier) &&
      exports &&
      typeof exports === "object" &&
      !instrumented.has(exports)
    ) {
      instrumented.add(exports);
      for (const name of Object.keys(exports)) {
        if (typeof exports[name] === "function" && !name.endsWith("Async")) {
          wrap(exports, name, `fs-safe.native.${name}`);
        }
      }
    }
    return exports;
  };
  syncBuiltinESMExports();
  const server = http.createServer((request, response) => {
    void handleProbe(request, response).catch((/** @type {unknown} */ error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  async function handleProbe(request, response) {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/start") {
      if (url.searchParams.get("allocations") === "1") {
        inspector = new Session();
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      records.clear();
      loop.reset();
      loop.enable();
      active = {
        start: performance.now(),
        cpu: process.cpuUsage(),
        thread: process.threadCpuUsage(),
        delayMs: Number(url.searchParams.get("delayMs") ?? 0),
        match: url.searchParams.get("match") ?? "",
        injected: false,
      };
      response.end("ok");
    } else if (url.pathname === "/stop" && active) {
      const measured = active;
      active = undefined;
      loop.disable();
      const metrics = {
        elapsedMs: performance.now() - measured.start,
        cpu: process.cpuUsage(measured.cpu),
        threadCpu: process.threadCpuUsage(measured.thread),
        loopP99Ms: loop.percentile(99) / 1e6,
        loopMaxMs: loop.max / 1e6,
      };
      let allocatedBytes;
      if (inspector) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
        allocatedBytes = sum(profile.head);
        inspector.disconnect();
        inspector = undefined;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ...metrics,
          allocatedBytes,
          injected: measured.injected,
          records: [...records.values()].toSorted((a, b) => b.totalMs - a.totalMs),
        }),
      );
    } else {
      response.statusCode = 404;
      response.end();
    }
  }
  server.listen(port, "127.0.0.1");
  server.unref();
}
