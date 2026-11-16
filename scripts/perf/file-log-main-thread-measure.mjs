// Node 26: --expose-gc scripts/perf/file-log-main-thread-measure.mjs
// --runtime-root <compiled legacy-finalizer/src> --root <new synthetic directory> --serve
// Send {"mode":"counts"|"timing"|"allocation","rotate":false|true} on stdin.
// Add "target":"default-report" for 2,300 path reports (100 windows), with no default writes.
// "target":"default-root" measures 100 cold root qualifications directly at the I/O owner.
// --team-shape adds 62k workspace files (1.1 GB), 3k session placeholders and a
// sparse 35-GiB opaque database placeholder; none are valid session/database data.
// One window is 23 independently settled batches, matching the observed Gateway minute.
// Keep baseline/candidate in separate processes: logger ownership is a process singleton.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    root: { type: "string" },
    serve: { type: "boolean" },
    "team-shape": { type: "boolean" },
    "owner-module": { type: "string" },
  },
});
assert(values["runtime-root"] && values.root && global.gc);
assert(
  Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Use Node 26 for exact main allocation",
);
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.TMPDIR = path.join(root, "tmp");
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
fs.mkdirSync(process.env.TMPDIR, { mode: 0o700 });
if (values["team-shape"]) {
  const state = process.env.OPENCLAW_STATE_DIR;
  const workspace = path.join(state, "workspace");
  const sessions = path.join(state, "agents", "synthetic", "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  for (let index = 0; index < 62_000; index++) {
    fs.writeFileSync(path.join(workspace, `${index}.txt`), Buffer.alloc(17_742));
  }
  for (let index = 0; index < 3_000; index++) {
    fs.writeFileSync(path.join(sessions, `${index}.fixture`), "synthetic session placeholder\n");
  }
  const fd = fs.openSync(path.join(state, "opaque-database.fixture"), "wx");
  fs.ftruncateSync(fd, 35 * 1024 ** 3);
  fs.closeSync(fd);
}
const runtimeRoot = path.resolve(values["runtime-root"]);
const load = (relative) => import(pathToFileURL(path.join(runtimeRoot, relative)).href);
const { getLogger, getResolvedLoggerSettings, applyLoggingConfig, flushLogger } =
  await load("logging/logger.js");
const { drainGlobalSingletonLifecycleState } = await load("shared/global-singleton.js");
const { runWithWorkerStartObserver } = await load("infra/worker-request-diagnostics.js");
const { resolveDefaultFileLogTarget } = values["owner-module"]
  ? await import(pathToFileURL(path.resolve(values["owner-module"])).href)
  : await load("logging/logger-file-io.js");
const starts = [];
const file = path.join(root, "warm.log");
const coldStart = performance.now();
const coldRss = process.memoryUsage().rss;
const coldCpu = process.cpuUsage();
const coldThread = process.threadCpuUsage();
const coldAllocation = getHeapStatistics().total_allocated_bytes;
applyLoggingConfig({ level: "info", file, maxFileBytes: 100 * 1024 * 1024 });
let logger = getLogger();
let sequence = 0;
const append = async () => {
  logger.info({ sequence: sequence++ }, "synthetic settled file-log batch");
  await flushLogger();
};
await runWithWorkerStartObserver((script) => starts.push(script), append);
console.log(
  JSON.stringify({
    phase: "cold",
    node: process.version,
    wallMs: performance.now() - coldStart,
    rssDelta: process.memoryUsage().rss - coldRss,
    processCpu: process.cpuUsage(coldCpu),
    mainCpu: process.threadCpuUsage(coldThread),
    allocatedBytes: getHeapStatistics().total_allocated_bytes - coldAllocation,
    workers: starts.length,
  }),
);
for (let index = 0; index < 50; index++) {
  await append();
}
const readLine = createInterface({ input: process.stdin });
try {
  for await (const line of readLine) {
    const command = JSON.parse(line);
    if (command.stop) {
      break;
    }
    const rotating = Boolean(command.rotate);
    const reporting = command.target === "default-report";
    const qualifying = command.target === "default-root";
    const preparationStart = performance.now();
    const preparationCpu = process.cpuUsage();
    const preparationThread = process.threadCpuUsage();
    const preparationAllocation = getHeapStatistics().total_allocated_bytes;
    applyLoggingConfig({
      level: "info",
      ...(reporting ? {} : { file: path.join(root, rotating ? "rotation.log" : "warm.log") }),
      maxFileBytes: rotating ? 1024 : 100 * 1024 * 1024,
    });
    logger = getLogger();
    const operation = qualifying
      ? () =>
          resolveDefaultFileLogTarget("openclaw-2000-01-01.log", {
            stateDir: process.env.OPENCLAW_STATE_DIR,
            tmpDir: process.env.TMPDIR,
          })
      : reporting
        ? () => getResolvedLoggerSettings()
        : append;
    await operation();
    const preparation = {
      wallMs: performance.now() - preparationStart,
      processCpu: process.cpuUsage(preparationCpu),
      mainCpu: process.threadCpuUsage(preparationThread),
      allocatedBytes: getHeapStatistics().total_allocated_bytes - preparationAllocation,
    };
    global.gc();
    const counts = {};
    const restore = [];
    let result;
    const operations = qualifying ? 100 : reporting ? 2_300 : 23;
    try {
      if (command.mode === "counts") {
        // Linux exposes unsupported methods such as lchmodSync as undefined.
        for (const key of Object.getOwnPropertyNames(fs).filter(
          (name) => name.endsWith("Sync") && typeof Reflect.get(fs, name) === "function",
        )) {
          const descriptor = Object.getOwnPropertyDescriptor(fs, key);
          Object.defineProperty(fs, key, {
            ...descriptor,
            value: new Proxy(descriptor.value, {
              apply(fn, receiver, args) {
                counts[key] = (counts[key] ?? 0) + 1;
                return Reflect.apply(fn, receiver, args);
              },
            }),
          });
          restore.push(() => Object.defineProperty(fs, key, descriptor));
        }
        const descriptor = Object.getOwnPropertyDescriptor(fs.realpathSync, "native");
        Object.defineProperty(fs.realpathSync, "native", {
          ...descriptor,
          value: new Proxy(descriptor.value, {
            apply(fn, receiver, args) {
              counts["realpathSync.native"] = (counts["realpathSync.native"] ?? 0) + 1;
              return Reflect.apply(fn, receiver, args);
            },
          }),
        });
        restore.push(() => Object.defineProperty(fs.realpathSync, "native", descriptor));
        syncBuiltinESMExports();
      }
      const cpu = process.cpuUsage(),
        thread = process.threadCpuUsage(),
        allocated = getHeapStatistics().total_allocated_bytes,
        rss = process.memoryUsage().rss,
        start = performance.now();
      for (let index = 0; index < operations; index++) {
        await operation();
      }
      const wallMs = performance.now() - start,
        main = process.threadCpuUsage(thread),
        total = process.cpuUsage(cpu),
        allocatedBytes = getHeapStatistics().total_allocated_bytes - allocated,
        rssAfter = process.memoryUsage().rss;
      result = {
        wallMs,
        mainCpuMs: (main.user + main.system) / 1000,
        processCpuMs: (total.user + total.system) / 1000,
        allocatedBytes,
        rssBefore: rss,
        rssAfter,
      };
    } finally {
      restore.toReversed().forEach((undo) => undo());
      if (command.mode === "counts") {
        syncBuiltinESMExports();
      }
    }
    console.log(
      JSON.stringify({
        phase: command.mode,
        rotating,
        reporting,
        qualifying,
        batches: operations,
        preparation,
        ...result,
        load: loadavg(),
        counts,
        workers: starts.length,
      }),
    );
  }
} finally {
  await flushLogger();
  await drainGlobalSingletonLifecycleState();
  fs.rmSync(root, { recursive: true, force: true });
}
