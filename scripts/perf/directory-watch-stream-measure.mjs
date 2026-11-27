/** Full host source + real stdout/MessagePort transport, with fixed native-protocol replay.
 * node --expose-gc scripts/perf/directory-watch-stream-measure.mjs --base <sha> --output <new-dir>
 * Five A1/A2/B arms, separate timing/allocation. --native characterizes real file churn first.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compileFunction } from "node:vm";
import { MessageChannel, Worker, parentPort, workerData } from "node:worker_threads";
import { isPathInside } from "@openclaw/fs-safe/path";

const script = fileURLToPath(import.meta.url);
const { values } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    producer: { type: "boolean" },
    events: { type: "string" },
    "batch-events": { type: "string" },
    output: { type: "string" },
    native: { type: "boolean" },
    arm: { type: "string" },
    allocations: { type: "boolean" },
  },
});

const roots = 800;
const events = workerData?.events ?? Number(values.events ?? 260_000);
const batchEvents = Number(values["batch-events"] ?? 65);
assert(
  Number.isSafeInteger(events) &&
    events > 0 &&
    Number.isSafeInteger(batchEvents) &&
    batchEvents > 0,
);
const hostFile = "src/infra/directory-watch-host.ts";
const observerFile = "src/infra/owned-directory-observation.ts";
function compile(source, dependencies, exports) {
  const js = stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export /gm, "");
  return compileFunction(
    `${js}\nreturn {${exports.join(",")}};`,
    Object.keys(dependencies),
  )(...Object.values(dependencies));
}
function loadHost(source, spawnHost) {
  return compile(
    source,
    {
      spawn: spawnHost,
      EventEmitter,
      MessageChannel,
      resolveGlobalSingleton: (_key, create) => create(),
      resolveRuntimeProcessEntrypointUrl: () => new URL(import.meta.url),
      resolveRuntimeWorkerArgv: () => [
        script,
        "--producer",
        "--events",
        String(events),
        "--batch-events",
        String(batchEvents),
      ],
    },
    ["createDirectoryWatchChannel", "installDirectoryWatchPort", "watchDirectory"],
  );
}
function percentile(samples, fraction = 0.95) {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}
function digest(eventsByOwner) {
  return createHash("sha256").update(JSON.stringify(eventsByOwner)).digest("hex");
}

if (workerData) {
  const { source, observer, port, root } = workerData;
  const send = parentPort.postMessage.bind(parentPort);
  const host = loadHost(source, () => {
    throw new Error("Worker must share host");
  });
  const { observeOwnedDirectory } = compile(
    observer,
    {
      fs: fs.promises,
      path,
      isPathInside,
      watchDirectory: host.watchDirectory,
      runInDetachedAsyncContext: (run) => run(),
    },
    ["observeOwnedDirectory"],
  );
  let packets = 0;
  port.on("message", () => packets++);
  host.installDirectoryWatchPort(port);
  let ready = 0;
  let received = 0;
  let counts = Array(roots).fill(0);
  let hashes = Array(roots).fill(0);
  let latencies = [];
  let cpu;
  const watches = Array.from({ length: roots }, (_, index) =>
    observeOwnedDirectory(
      path.join(root, String(index)),
      (filename, event) => {
        if (filename === undefined) {
          if (++ready === roots) {
            send({ ready: true });
          }
          return;
        }
        const [sequence, stamp] = filename.split("@");
        const number = Number(sequence.slice(sequence.lastIndexOf("/") + 1));
        assert.equal(number % roots, index);
        assert.equal(event, number % 3 === 0 ? "rename" : "change");
        counts[index]++;
        hashes[index] = (Math.imul(hashes[index], 31) + number) >>> 0;
        if (stamp) {
          latencies.push(Number(process.hrtime.bigint()) / 1e6 - Number(stamp));
        }
        if (++received === events) {
          const used = process.threadCpuUsage(cpu);
          send({
            received,
            packets,
            digest: digest([counts, hashes]),
            workerCpuMs: (used.user + used.system) / 1000,
            latencyP95Ms: percentile(latencies),
            latencyMaxMs: Math.max(...latencies),
          });
        }
      },
      { reconcileIntervalMs: 3_600_000 },
    ),
  );
  parentPort.on("message", (message) => {
    if (message === "start") {
      received = 0;
      packets = 0;
      counts = Array(roots).fill(0);
      hashes = Array(roots).fill(0);
      latencies = [];
      cpu = process.threadCpuUsage();
      send({ started: true });
    } else if (message === "close") {
      for (const watch of watches) {
        watch.close();
      }
      port.close();
      parentPort.close();
    }
  });
} else if (process.argv.includes("--producer")) {
  const ids = [];
  let buffered = "";
  process.stdin.setEncoding("utf8").on(
    "data",
    /** @param {string} chunk */ (chunk) => {
      const lines = (buffered + chunk).split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        const request = JSON.parse(line);
        if (request.run) {
          void (async () => {
            const cpu = process.cpuUsage();
            for (let start = 0; start < events; start += batchEvents) {
              const stamp = Number(process.hrtime.bigint()) / 1e6;
              let output = "";
              for (
                let sequence = start;
                sequence < Math.min(start + batchEvents, events);
                sequence++
              ) {
                output +=
                  JSON.stringify({
                    id: ids[sequence % roots],
                    event: sequence % 3 === 0 ? "rename" : "change",
                    filename: `${sequence % 2 ? ".git" : "dist"}/${sequence}${sequence === start ? `@${stamp}` : ""}`,
                  }) + "\n";
              }
              if (!process.stdout.write(output)) {
                await once(process.stdout, "drain");
              }
              await delay(1);
            }
            const used = process.cpuUsage(cpu);
            process.stderr.write(
              JSON.stringify({ producerCpuMs: (used.user + used.system) / 1000 }) + "\n",
            );
          })();
        } else if (request.path) {
          ids.push(request.id);
          process.stdout.write(JSON.stringify({ id: request.id, event: "change" }) + "\n");
        }
      }
    },
  );
  process.stdin.on("end", () => process.exit(0));
} else {
  assert(
    values.base && values.output && global.gc,
    "Supply --base, fresh --output and --expose-gc",
  );
  const output = path.resolve(values.output);
  fs.mkdirSync(output);
  const root = path.join(output, "fixture");
  fs.mkdirSync(root);
  const base = execFileSync("git", ["rev-parse", `${values.base}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const sources = {
    A: execFileSync("git", ["show", `${base}:${hostFile}`], { encoding: "utf8" }),
    B: fs.readFileSync(hostFile, "utf8"),
    observer: fs.readFileSync(observerFile, "utf8"),
  };
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify({ base, sources }));
  for (let index = 0; index < roots; index++) {
    fs.mkdirSync(path.join(root, String(index)));
  }
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    if (values.native) {
      // 62,400 real files, 1.1 GB logical payload; no database contents are read by this flow.
      const payload = Buffer.alloc(17_628, "x");
      for (let index = 0; index < roots; index++) {
        for (let file = 0; file < 78; file++) {
          fs.writeFileSync(path.join(root, String(index), `source-${file}`), payload);
        }
      }
      let ready = 0;
      let nativeEvents = 0;
      let chunks = 0;
      let bytes = 0;
      const admitted = Promise.withResolvers();
      const changed = new Set();
      let helper;
      const host = loadHost(sources.A, () => {
        helper = spawn(
          process.execPath,
          [
            "--import",
            path.resolve("scripts/tsx.mjs"),
            path.resolve("src/infra/directory-watch-host.worker.ts"),
            String(process.pid),
          ],
          { stdio: ["pipe", "pipe", "inherit"] },
        );
        helper.stdout.on("data", (chunk) => {
          chunks++;
          bytes += Buffer.byteLength(chunk);
        });
        return helper;
      });
      const watches = Array.from({ length: roots }, (_, index) =>
        host.watchDirectory(path.join(root, String(index)), (_event, filename) => {
          if (filename === undefined) {
            if (++ready % 100 === 0) {
              console.log(JSON.stringify({ admitted: ready }));
            }
            if (ready === roots) {
              admitted.resolve();
            }
          } else {
            nativeEvents++;
            changed.add(index);
          }
        }),
      );
      await admitted.promise;
      chunks = 0;
      bytes = 0;
      const start = performance.now();
      const churn = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
      import fs from "node:fs";
      import path from "node:path";
      for (let index = 0; index < ${roots}; index++) {
        const dir = path.join(process.argv[1], String(index));
        for (let file = 0; file < 10; file++) {
          fs.writeFileSync(path.join(dir, 'build-' + file + '.tmp'), 'synthetic build');
          fs.renameSync(path.join(dir, 'build-' + file + '.tmp'), path.join(dir, 'build-' + file + '.js'));
          fs.unlinkSync(path.join(dir, 'build-' + file + '.js'));
        }
      }
    `,
          root,
        ],
        { stdio: "inherit" },
      );
      const [churnCode] = await once(churn, "exit");
      assert.equal(churnCode, 0);
      // A fixed drain window characterizes native delivery, never production freshness polling.
      await delay(1000);
      const elapsedMs = performance.now() - start;
      const result = {
        roots,
        files: 62400,
        logicalBytes: 62400 * payload.length,
        operations: 24000,
        notifiedRoots: changed.size,
        nativeEvents,
        chunks,
        bytes,
        elapsedMs,
        eventsPerSecond: (nativeEvents / elapsedMs) * 1000,
        platform: process.platform,
      };
      fs.writeFileSync(path.join(output, "native.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ native: result }));
      const exited = once(helper, "exit");
      for (const watch of watches) {
        watch.close();
      }
      await exited;
    }
    if (!values.arm) {
      const results = [];
      for (const allocations of [false, true]) {
        for (let sample = 0; sample < 5; sample++) {
          for (const arm of sample % 2 ? ["B", "A2", "A1"] : ["A1", "A2", "B"]) {
            const destination = path.join(
              output,
              `${allocations ? "allocation" : "timing"}-${sample}-${arm}`,
            );
            const log = fs.openSync(`${destination}.log`, "w");
            const run = spawn(
              process.execPath,
              [
                "--expose-gc",
                script,
                "--base",
                base,
                "--output",
                destination,
                "--events",
                String(events),
                "--batch-events",
                String(batchEvents),
                "--arm",
                arm,
                ...(allocations ? ["--allocations"] : []),
              ],
              { stdio: ["ignore", log, log] },
            );
            const [code] = await once(run, "exit");
            fs.closeSync(log);
            assert.equal(code, 0, `Arm failed: ${destination}.log`);
            const [result] = JSON.parse(
              fs.readFileSync(path.join(destination, "results.json"), "utf8"),
            );
            result.sample = sample;
            results.push(result);
            console.log(JSON.stringify(result));
            fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
          }
        }
      }
    } else {
      const expectedCounts = Array(roots).fill(0);
      const expectedHashes = Array(roots).fill(0);
      for (let index = 0; index < events; index++) {
        expectedCounts[index % roots]++;
        expectedHashes[index % roots] =
          (Math.imul(expectedHashes[index % roots], 31) + index) >>> 0;
      }
      const expectedDigest = digest([expectedCounts, expectedHashes]);
      const results = [];
      const allocations = Boolean(values.allocations);
      const sample = 0;
      const arm = values.arm;
      let helper;
      let chunks = 0;
      let bytes = 0;
      let stderr = "";
      const host = loadHost(sources[arm === "B" ? "B" : "A"], (...args) => {
        helper = spawn(args[0], args[1], { ...args[2], stdio: ["pipe", "pipe", "pipe"] });
        helper.stdout.on("data", (chunk) => {
          chunks++;
          bytes += Buffer.byteLength(chunk);
        });
        helper.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        return helper;
      });
      const channel = host.createDirectoryWatchChannel();
      const worker = new Worker(new URL(import.meta.url), {
        workerData: {
          source: sources[arm === "B" ? "B" : "A"],
          observer: sources.observer,
          events,
          port: channel.port,
          root,
        },
        transferList: [channel.port],
      });
      const sendWorker = worker.postMessage.bind(worker);
      await once(worker, "message");
      // Equal full-flow warmup, excluded from measurements.
      sendWorker("start");
      await once(worker, "message");
      helper.stdin.write('{"run":true}\n');
      await once(worker, "message");
      await delay(20);
      sendWorker("start");
      await once(worker, "message");
      global.gc();
      const inspector = new Session();
      inspector.connect();
      if (allocations) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      } else {
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
      }
      chunks = 0;
      bytes = 0;
      stderr = "";
      const cpu = process.cpuUsage();
      const thread = process.threadCpuUsage();
      const started = performance.now();
      helper.stdin.write('{"run":true}\n');
      const [reply] = await once(worker, "message");
      const elapsedMs = performance.now() - started;
      const threadUsed = process.threadCpuUsage(thread);
      const used = process.cpuUsage(cpu);
      assert.equal(reply.received, events);
      assert.equal(reply.digest, expectedDigest);
      let allocatedBytes;
      const prefix = `${allocations ? "allocation" : "timing"}-${sample}-${arm}`;
      if (allocations) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const count = (node) =>
          node.selfSize + node.children.reduce((sum, child) => sum + count(child), 0);
        allocatedBytes = count(profile.head);
        fs.writeFileSync(path.join(output, `${prefix}.heapprofile`), JSON.stringify(profile));
      } else {
        const { profile } = await inspector.post("Profiler.stop");
        fs.writeFileSync(path.join(output, `${prefix}.cpuprofile`), JSON.stringify(profile));
      }
      inspector.disconnect();
      await delay(20);
      const result = {
        arm,
        events,
        batchEvents,
        sample,
        allocations,
        chunks,
        bytes,
        elapsedMs,
        hostLoad: loadavg(),
        mainCpuMs: (threadUsed.user + threadUsed.system) / 1000,
        processCpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
        ...reply,
        ...JSON.parse(stderr.trim()),
      };
      results.push(result);
      console.log(JSON.stringify(result));
      fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
      const exited = once(helper, "exit");
      const workerExit = once(worker, "exit");
      sendWorker("close");
      await workerExit;
      channel.close();
      await exited;
    }
  } finally {
    clearInterval(keepAlive);
    fs.rmSync(root, { recursive: true });
  }
}
