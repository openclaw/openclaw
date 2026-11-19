/**
 * node --import ./scripts/tsx.mjs scripts/perf/image-worker-buffers-measure.mjs BASELINE_DIR OUTPUT [iterations=1000] [pairs=2] [--copies]
 * BASELINE_DIR contains src/media/{image-processor.worker,photon.runtime}.ts from the base.
 * Fresh real image workers, counterbalanced AB/BA, deterministic 256px PNG/BMP inputs.
 * Uses the production task transport, transfer lists, codecs and idle policy. Never forces GC.
 * Accept byte-identical output and fewer copied bytes without a material controlled CPU/GC loss.
 * --copies separately instruments Buffer.from(view)/Uint8Array.from; those timings are diagnostic.
 * Timing arms report worker CPU, V8 JS allocation, natural GC, loop delay and memory over time.
 * This owner workload does not establish Gateway-wide or production-frequency improvements.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { encodePngRgba } from "rastermill";

const [baseline, destination, iterationsArg = "1000", pairsArg = "2", mode] = process.argv.slice(2);
assert(baseline && destination, "BASELINE_DIR OUTPUT required");
const iterations = Number(iterationsArg);
const pairs = Number(pairsArg);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(mode === undefined || mode === "--copies");
const output = path.resolve(destination);
await mkdir(output);
for (const directory of ["home", "state", "tmp"]) {
  await mkdir(path.join(output, directory));
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const files = ["src/media/image-processor.worker.ts", "src/media/photon.runtime.ts"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = {};
for (const side of ["baseline", "candidate"]) {
  sources[side] = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        sha256(await readFile(path.join(side === "baseline" ? baseline : root, file))),
      ]),
    ),
  );
}
const width = 256;
const pixels = new Uint8Array(width * width * 4);
let seed = 12345;
for (let i = 0; i < pixels.length; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  pixels[i] = i % 4 === 3 ? 255 : seed >>> 24;
}
const bmp = Buffer.alloc(54 + width * width * 3);
bmp.write("BM");
bmp.writeUInt32LE(bmp.length, 2);
bmp.writeUInt32LE(54, 10);
bmp.writeUInt32LE(40, 14);
bmp.writeInt32LE(width, 18);
bmp.writeInt32LE(width, 22);
bmp.writeUInt16LE(1, 26);
bmp.writeUInt16LE(24, 28);
bmp.writeUInt32LE(bmp.length - 54, 34);
for (let i = 0; i < width * width; i++) {
  bmp[54 + i * 3] = pixels[i * 4 + 2];
  bmp[55 + i * 3] = pixels[i * 4 + 1];
  bmp[56 + i * 3] = pixels[i * 4];
}
const png = encodePngRgba(pixels, width, width, 1);
const results = [];
const digests = new Map();
const entry = new URL("../../src/media/image-processor.worker.ts", import.meta.url).href;
for (let pair = 0; pair < pairs; pair++) {
  for (const kind of ["bmpToPng", "encode"]) {
    for (const side of pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      const diagnostics = new MessageChannel();
      const tasks = new MessageChannel();
      const copies = new MessageChannel();
      const ready = Promise.withResolvers();
      const taskReady = Promise.withResolvers();
      const pending = new Map();
      const memory = [];
      let memoryPort;
      let sequence = 0;
      const instrumentedEntry = `
        import {workerData} from 'node:worker_threads';
        let active = false;
        let counts = {};
        for (const [owner, label] of [[Buffer, 'Buffer.from(view)'], [Uint8Array, 'Uint8Array.from']]) {
          const original = owner.from;
          owner.from = function (...args) {
            const result = Reflect.apply(original, this, args);
            if (active && ArrayBuffer.isView(args[0])) {
              const count = counts[label] ??= {calls: 0, bytes: 0};
              count.calls++; count.bytes += result.byteLength;
            }
            return result;
          };
        }
        workerData.copies.on('message', ({id, operation}) => {
          active = operation === 'begin';
          if (active) counts = {};
          workerData.copies.postMessage({id, value: counts});
        });
        await import(${JSON.stringify(entry)});
      `;
      const worker = new Worker(new URL("./worker-module-graphs-worker.mjs", import.meta.url), {
        workerData: {
          name: `image-processor-${kind}-${side}`,
          entry: mode
            ? `data:text/javascript;base64,${Buffer.from(instrumentedEntry).toString("base64")}`
            : entry,
          baselineDir: side === "baseline" ? path.resolve(baseline) : root,
          baselineFiles: files,
          captureGc: true,
          gcDetails: path.join(output, `${pair}-${kind}-${side}-gc.json`),
          diagnostics: diagnostics.port2,
          copies: copies.port2,
        },
        transferList: [diagnostics.port2, copies.port2],
        env: {
          PATH: process.env.PATH,
          HOME: path.join(output, "home"),
          OPENCLAW_HOME: path.join(output, "home"),
          OPENCLAW_STATE_DIR: path.join(output, "state"),
          TMPDIR: path.join(output, "tmp"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      const fail = (error) => {
        ready.reject(error);
        taskReady.reject(error);
        for (const item of pending.values()) {
          item.reject(error);
        }
      };
      void taskReady.promise.catch(() => {});
      worker.on("error", fail);
      const timeout = setTimeout(
        () => fail(new Error("Image worker measurement timed out")),
        120000,
      );
      const respond = (message) => {
        const item = pending.get(message.id ?? message.taskId);
        pending.delete(message.id ?? message.taskId);
        if (message.error) {
          item?.reject(new Error(message.error));
        } else {
          item?.resolve(message.value);
        }
      };
      diagnostics.port1.on("message", (message) =>
        message.ready ? ready.resolve() : respond(message),
      );
      copies.port1.on("message", respond);
      tasks.port1.on("message", (message) => {
        if (message.status === "ready") {
          taskReady.resolve();
        } else if (message.status === "memory") {
          memoryPort = message.port;
          memoryPort.on("message", (sample) => memory.push({ atMs: performance.now(), ...sample }));
        } else {
          respond(message);
        }
      });
      const request = (port, message, transfers = []) => {
        const id = ++sequence;
        const response = Promise.withResolvers();
        pending.set(id, response);
        port.postMessage({ id, taskId: id, ...message }, transfers);
        return response.promise;
      };
      const run = async () => {
        const input = Uint8Array.from(kind === "bmpToPng" ? bmp : png);
        const reply = await request(
          tasks.port1,
          {
            input: { kind, input, ...(kind === "encode" ? { options: { format: "png" } } : {}) },
            sampleMemory: true,
            nativeSections: new SharedArrayBuffer(4),
            taskContext: { deletedAgentDatabaseFences: [] },
          },
          [input.buffer],
        );
        assert.equal(reply.kind, kind, reply.error?.message);
        return kind === "encode" ? reply.value.data : reply.value;
      };
      try {
        await ready.promise;
        worker.postMessage({ type: "openclaw.worker-task-port", port: tasks.port2 }, [tasks.port2]);
        await taskReady.promise;
        const first = await run();
        const digest = sha256(first);
        assert.equal(digest, digests.get(kind) ?? digest);
        digests.set(kind, digest);
        for (let i = 0; i < 20; i++) {
          await run();
        }
        const hostLoad = loadavg();
        const before = await request(diagnostics.port1, { operation: "begin" });
        if (mode) {
          await request(copies.port1, { operation: "begin" });
        }
        const started = performance.now();
        let last;
        for (let i = 0; i < iterations; i++) {
          last = await run();
          if (i % 100 === 0) {
            memoryPort?.postMessage(undefined, []);
          }
        }
        const elapsedMs = performance.now() - started;
        const copyCounts = mode ? await request(copies.port1, { operation: "end" }) : undefined;
        const measured = await request(diagnostics.port1, { operation: "end" });
        assert.equal(sha256(last), digest);
        const result = {
          pair,
          kind,
          side,
          iterations,
          elapsedMs,
          hostLoad,
          inputBytes: kind === "encode" ? png.length : bmp.length,
          outputBytes: first.length,
          beforeMemory: before.memory,
          ...measured,
          copyCounts,
          memorySamples: memory,
        };
        results.push(result);
        await writeFile(
          path.join(output, "results.json"),
          JSON.stringify({ sources, mode: mode ?? "timing", results }, null, 2),
        );
        console.log(JSON.stringify({ ...result, memorySamples: undefined }));
      } finally {
        clearTimeout(timeout);
        await worker.terminate();
        diagnostics.port1.close();
        tasks.port1.close();
        copies.port1.close();
        memoryPort?.close();
      }
    }
  }
}
