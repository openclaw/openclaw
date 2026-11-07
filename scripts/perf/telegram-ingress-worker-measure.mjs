// Telegram ingress worker cold start against a loopback Bot API, for one or two built checkouts.
// node scripts/perf/telegram-ingress-worker-measure.mjs --build-dir <head> [--compare-build-dir <base>] --samples 10 --output <json>
// Each sample constructs the shipped worker (dist/telegram-ingress-worker.runtime.js) with the parent's
// workerData contract. The fake API answers one empty short poll, one 20-update batch (acked like the
// parent spool), then empty long polls. Arms alternate order per sample.
// --debug-proxy-capture sets OPENCLAW_DEBUG_PROXY_ENABLED=1 in the worker env (head reads the parent flag).
// Module census uses a load hook in the wrapper isolate (both arms pay it). Retained heap is read after a
// heap snapshot forces a full GC. CPU and heap are isolate counters, not process RSS.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

const { values } = parseArgs({
  options: {
    "build-dir": { type: "string" },
    "compare-build-dir": { type: "string" },
    samples: { type: "string", default: "10" },
    "steady-polls": { type: "string", default: "10" },
    "debug-proxy-capture": { type: "boolean" },
    output: { type: "string" },
  },
});
assert(values["build-dir"] && values.output, "--build-dir and --output are required");
const samples = Number(values.samples);
const steadyPolls = Number(values["steady-polls"]);
assert(Number.isSafeInteger(samples) && samples > 0, "--samples must be positive");
assert(Number.isSafeInteger(steadyPolls) && steadyPolls > 0, "--steady-polls must be positive");
const arms = Object.entries({
  head: values["build-dir"],
  ...(values["compare-build-dir"] ? { base: values["compare-build-dir"] } : {}),
}).map(([name, root]) => {
  const entry = path.resolve(root, "dist/telegram-ingress-worker.runtime.js");
  fs.accessSync(entry);
  return { name, entry: pathToFileURL(entry).href };
});
const BATCH = 20;
const FIRST_UPDATE_ID = 1000;

const output = path.resolve(values.output);
fs.mkdirSync(path.dirname(output), { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.dirname(output), "telegram-ingress-"));
for (const name of ["home", "state", "tmp"]) {
  fs.mkdirSync(path.join(scratch, name), { recursive: true });
}
const configPath = path.join(scratch, "openclaw.json");
// Worker loggers must not append to the operator's default rolling log.
fs.writeFileSync(
  configPath,
  JSON.stringify({ logging: { file: path.join(scratch, "worker.log") } }),
);
const environment = {
  ...process.env,
  HOME: path.join(scratch, "home"),
  OPENCLAW_HOME: path.join(scratch, "home"),
  OPENCLAW_STATE_DIR: path.join(scratch, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  TMPDIR: path.join(scratch, "tmp"),
  ...(values["debug-proxy-capture"] ? { OPENCLAW_DEBUG_PROXY_ENABLED: "1" } : {}),
};

// Per-token poll scripts keep samples independent on one listener.
const polls = new Map();
const server = http.createServer((request, response) => {
  const token = /^\/bot([^/]+)\/getUpdates$/u.exec(request.url ?? "")?.[1];
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const state = token ? polls.get(token) : undefined;
    if (!state) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.requests.push(body);
    const index = state.requests.length;
    const result =
      index === 2
        ? Array.from({ length: BATCH }, (_, offset) => ({
            update_id: FIRST_UPDATE_ID + offset,
            message: {
              message_id: offset + 1,
              date: 1_793_577_600,
              chat: { id: 4242, type: "private" },
              from: { id: 4242, is_bot: false, first_name: "Bench" },
              text: `synthetic ${offset}`,
            },
          }))
        : [];
    // Long polls answer quickly; the worker's empty-poll backoff paces the steady phase.
    setTimeout(
      () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result }));
      },
      index > 2 ? 20 : 0,
    );
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const apiRoot = `http://127.0.0.1:${server.address().port}`;

const wrapper = `
const { parentPort, workerData } = require("node:worker_threads");
const { registerHooks } = require("node:module");
const modules = new Set();
registerHooks({
  load(url, context, next) {
    if (url.startsWith("file:")) modules.add(url);
    return next(url, context);
  },
});
parentPort.on("message", (message) => {
  if (message?.type === "bench-census") {
    const urls = [...modules];
    parentPort.postMessage({
      type: "bench-census",
      modules: urls.length,
      proxyCaptureModules: urls.filter((url) => url.includes("proxy-capture")).length,
    });
  }
});
import(workerData.benchEntry);
`;

async function heapAfterFullGc(worker) {
  // A heap snapshot runs a full GC first; drain it without keeping the bytes.
  const stream = await worker.getHeapSnapshot();
  stream.resume();
  await once(stream, "end");
  return (await worker.getHeapStatistics()).used_heap_size;
}

const cpuMs = (usage) => (usage.user + usage.system) / 1000;

async function runSample(arm, sampleIndex) {
  const token = `bench-${arm.name}-${sampleIndex}`;
  const state = { requests: [] };
  polls.set(token, state);
  const started = performance.now();
  const worker = new Worker(wrapper, {
    eval: true,
    env: environment,
    execArgv: [],
    workerData: {
      token,
      accountId: "bench",
      initialUpdateId: null,
      apiRoot,
      timeoutSeconds: 1,
      debugProxyCapture: values["debug-proxy-capture"] === true,
      runtime: "openclaw.telegram-ingress-worker",
      benchEntry: arm.entry,
    },
  });
  const result = { arm: arm.name, sample: sampleIndex };
  let pollSuccesses = 0;
  let ackedUpdateId;
  const done = Promise.withResolvers();
  const census = Promise.withResolvers();
  const steady = Promise.withResolvers();
  let steadyTarget = Number.POSITIVE_INFINITY;
  /** @type {Promise<NodeJS.CpuUsage> | undefined} */
  let firstPollCpu;
  /** @type {Promise<NodeJS.CpuUsage> | undefined} */
  let batchCpu;
  worker.on("error", (error) => {
    done.reject(error);
    census.reject(error);
    steady.reject(error);
  });
  worker.on("message", (message) => {
    if (message.type === "bench-census") {
      census.resolve(message);
    } else if (message.type === "updates") {
      ackedUpdateId = FIRST_UPDATE_ID + message.updates.length - 1;
      worker.postMessage(
        {
          type: "spool-ack",
          requestId: message.requestId,
          result: { ok: true, updateId: ackedUpdateId },
        },
        [],
      );
    } else if (message.type === "poll-error") {
      done.reject(new Error(`${arm.name} poll error: ${message.message}`));
    } else if (message.type === "poll-success") {
      pollSuccesses += 1;
      if (pollSuccesses === 1) {
        result.firstPollWallMs = performance.now() - started;
        firstPollCpu = worker.cpuUsage();
      } else if (pollSuccesses === 2) {
        batchCpu = worker.cpuUsage();
        done.resolve();
      }
      if (pollSuccesses >= steadyTarget) {
        steady.resolve();
      }
    }
  });
  const timeout = setTimeout(() => done.reject(new Error(`${arm.name} sample timed out`)), 60_000);
  try {
    await done.promise;
    result.firstPollCpuMs = cpuMs(await firstPollCpu);
    result.batchCpuMs = cpuMs(await batchCpu) - result.firstPollCpuMs;
    result.retainedHeapBytes = await heapAfterFullGc(worker);
    const steadyStartCpu = await worker.cpuUsage();
    steadyTarget = pollSuccesses + steadyPolls;
    await steady.promise;
    result.steadyCpuPerPollMs =
      (cpuMs(await worker.cpuUsage()) - cpuMs(steadyStartCpu)) / steadyPolls;
    worker.postMessage({ type: "bench-census" }, []);
    const counts = await census.promise;
    result.modules = counts.modules;
    result.proxyCaptureModules = counts.proxyCaptureModules;
    result.ackedUpdateId = ackedUpdateId;
    result.pollOffsets = state.requests.slice(0, 3).map((body) => body.offset ?? null);
    result.pollTimeouts = state.requests.slice(0, 3).map((body) => body.timeout);
    return result;
  } finally {
    clearTimeout(timeout);
    worker.postMessage({ type: "stop" }, []);
    await worker.terminate();
    polls.delete(token);
  }
}

function summarize(rows, key) {
  const sorted = rows.map((row) => row[key]).toSorted((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: at(0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

const rows = [];
try {
  for (let index = 0; index < samples; index++) {
    const order = index % 2 === 0 ? arms : arms.toReversed();
    for (const arm of order) {
      rows.push(await runSample(arm, index));
    }
  }
} finally {
  server.close();
}
const keys = [
  "modules",
  "proxyCaptureModules",
  "retainedHeapBytes",
  "firstPollWallMs",
  "firstPollCpuMs",
  "batchCpuMs",
  "steadyCpuPerPollMs",
];
const report = {
  samples,
  steadyPolls,
  debugProxyCapture: values["debug-proxy-capture"] === true,
  arms: Object.fromEntries(
    arms.map((arm) => {
      const armRows = rows.filter((row) => row.arm === arm.name);
      return [
        arm.name,
        {
          entry: arm.entry,
          ackedUpdateIds: [...new Set(armRows.map((row) => row.ackedUpdateId))],
          pollOffsets: [...new Set(armRows.map((row) => JSON.stringify(row.pollOffsets)))],
          pollTimeouts: [...new Set(armRows.map((row) => JSON.stringify(row.pollTimeouts)))],
          ...Object.fromEntries(keys.map((key) => [key, summarize(armRows, key)])),
        },
      ];
    }),
  ),
  rows,
};
fs.writeFileSync(output, JSON.stringify(report, null, 2));
fs.rmSync(scratch, { recursive: true, force: true });
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(report.arms).map(([name, arm]) => [
        name,
        Object.fromEntries(keys.map((key) => [key, arm[key].median])),
      ]),
    ),
  ),
);
