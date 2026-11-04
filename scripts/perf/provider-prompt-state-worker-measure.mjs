/**
 * Measure the real provider-prompt-state worker, including input/reply transport.
 * Save the baseline provider-prompt-serialization.ts beside this checkout (or in
 * .local), then run from the candidate checkout:
 * node --import ./scripts/tsx.mjs scripts/perf/provider-prompt-state-worker-measure.mjs \
 *   BASE_OWNER.ts OUTPUT_DIR
 * Five alternating AB/BA pairs, 3,000 tasks/arm after 100 warmups; untraced CPU/GC
 * and a separate allocation pass including minor/major-collected objects.
 * Accept identical reply bytes/order and lower allocation without controlled CPU
 * or GC regression. This is an owner probe, not whole-Gateway stress evidence.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isMainThread, MessageChannel, Worker, workerData } from "node:worker_threads";

if (!isMainThread) {
  const session = new Session();
  session.connect();
  let cpu;
  let started;
  let finished = Infinity;
  let observer;
  let gc = [];
  workerData.control.on("message", async (action) => {
    if (action === "start") {
      gc = [];
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime >= started && entry.startTime < finished) {
            gc.push({ kind: entry.detail.kind, ms: entry.duration });
          }
        }
      });
      observer.observe({ entryTypes: ["gc"] });
      if (workerData.mode === "allocation") {
        await session.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      cpu = process.threadCpuUsage();
      started = performance.now();
      workerData.control.postMessage({ ready: true }, []);
    } else {
      finished = performance.now();
      const used = process.threadCpuUsage(cpu);
      const profile =
        workerData.mode === "allocation"
          ? (await session.post("HeapProfiler.stopSampling")).profile
          : undefined;
      await setImmediate();
      await setImmediate();
      observer.disconnect();
      workerData.control.postMessage(
        {
          cpuMs: (used.user + used.system) / 1000,
          elapsedMs: finished - started,
          profile,
          gc,
          memory: process.memoryUsage(),
        },
        [],
      );
    }
  });
  await import(workerData.entry);
  workerData.control.postMessage({ ready: true }, []);
} else {
  const [baseFile, output] = process.argv.slice(2);
  assert(baseFile && output, "BASE_OWNER.ts OUTPUT_DIR required");
  const directory = path.resolve(output);
  await mkdir(directory, { recursive: true });
  const candidate = new URL(
    "../../src/agents/embedded-agent-runner/provider-prompt-state.worker.ts",
    import.meta.url,
  );
  const owner = new URL(
    "../../src/agents/embedded-agent-runner/provider-prompt-serialization.ts",
    import.meta.url,
  );
  const source = await readFile(candidate, "utf8");
  // Preserve the real worker handler/transport; substitute only the baseline owner.
  const baseline = path.join(directory, "baseline.worker.ts");
  await writeFile(
    baseline,
    source.replace(/"(\.\.?\/[^"]+)"/g, (_match, specifier) =>
      JSON.stringify(
        specifier === "./provider-prompt-serialization.js"
          ? pathToFileURL(path.resolve(baseFile)).href
          : new URL(specifier.replace(/\.js$/, ".ts"), candidate).href,
      ),
    ),
  );
  const sources = {
    baseline: hash("sha256", await readFile(baseFile)),
    candidate: hash("sha256", await readFile(owner)),
    worker: hash("sha256", source),
  };
  const payload = {
    model: "synthetic",
    instructions: "Synthetic system ".repeat(400),
    tools: Array.from({ length: 40 }, (_, i) => ({
      type: "function",
      name: `tool_${i}`,
      description: "Synthetic tool description ".repeat(20),
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    })),
    input: Array.from({ length: 64 }, (_, i) => ({
      role: "user",
      content: `Synthetic text ${i} ` + "x".repeat(4096),
    })),
    stream: true,
  };
  const wire = new TextEncoder().encode(JSON.stringify(payload));
  const expectedDigest = hash("sha256", wire);
  const iterations = 3000;
  const rows = [];
  let expectedReply;
  const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
  try {
    for (const mode of ["timing", "allocation"]) {
      for (let pair = 0; pair < 5; pair++) {
        for (const label of pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
          const { port1, port2 } = new MessageChannel();
          const worker = new Worker(new URL(import.meta.url), {
            workerData: {
              control: port2,
              mode,
              entry: label === "baseline" ? pathToFileURL(baseline).href : candidate.href,
            },
            transferList: [port2],
          });
          const receive = (port) =>
            new Promise((resolve, reject) => {
              /** @param {Error} error */
              const onError = (error) => {
                port.off("message", onMessage);
                reject(error);
              };
              const onMessage = (reply) => {
                worker.off("error", onError);
                resolve(reply);
              };
              worker.once("error", onError);
              port.once("message", onMessage);
            });
          let taskId = 0;
          const run = async (count) => {
            for (let i = 0; i < count; i++) {
              const reply = receive(worker);
              worker.postMessage(
                {
                  taskId: ++taskId,
                  input: { payload, encode: true },
                  taskContext: { deletedAgentDatabaseFences: [] },
                  nativeSections: new SharedArrayBuffer(16),
                },
                [],
              );
              const result = await reply;
              assert.equal(result.status, "ok", result.error);
              assert.equal(result.value.prompt.digest, expectedDigest);
              if (i === 0) {
                assert.deepEqual(result.value.prompt.encoded.body, wire);
                // Include property order and every diagnostic field in cross-arm parity.
                const signature = JSON.stringify({
                  ...result.value.prompt,
                  encoded: { stream: result.value.prompt.encoded.stream },
                });
                expectedReply ??= signature;
                assert.equal(signature, expectedReply);
              }
            }
          };
          try {
            await receive(port1);
            await run(100);
            let reply = receive(port1);
            port1.postMessage("start");
            await reply;
            const hostLoadBefore = loadavg();
            await run(iterations);
            reply = receive(port1);
            port1.postMessage("stop");
            const { profile, ...result } = await reply;
            const row = {
              label,
              pair,
              mode,
              iterations,
              hostLoadBefore,
              hostLoadAfter: loadavg(),
              ...result,
              allocatedBytes: profile ? sum(profile.head) : undefined,
            };
            rows.push(row);
            if (profile) {
              await writeFile(
                path.join(directory, `${mode}-${pair}-${label}.json`),
                JSON.stringify(profile),
              );
            }
            await writeFile(
              path.join(directory, "results.json"),
              JSON.stringify(
                {
                  node: process.version,
                  sources,
                  wireBytes: wire.byteLength,
                  expectedDigest,
                  rows,
                },
                null,
                2,
              ),
            );
            console.log(
              JSON.stringify({
                ...row,
                gc: { count: row.gc.length, ms: row.gc.reduce((n, entry) => n + entry.ms, 0) },
              }),
            );
          } finally {
            await worker.terminate();
            port1.close();
          }
        }
      }
    }
  } finally {
    await rm(baseline);
  }
}
