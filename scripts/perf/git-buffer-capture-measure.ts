/**
 * Measure runCommandBuffered's capture owner with immutable 64 KiB pipe chunks.
 * Run on each revision: node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/git-buffer-capture-measure.ts [iterations=2000]
 * The runner fixture removes process startup from this microbenchmark; real Git
 * and worker lifecycle tests must cover transport. No production modules change.
 * Native buffer bytes count intermediate copies plus the final concatenation;
 * the inspector samples JS allocations separately, including collected objects.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";

const iterations = Number(process.argv[2] ?? 2000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const runner = fileURLToPath(new URL("../../src/process/exec-runner.ts", import.meta.url));
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && fileURLToPath(url) === runner) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const chunk = Buffer.alloc(64 * 1024, 255);
          export async function runCommandWithTimeout(_argv, options) {
            for (let i = 0; i < 4; i++) options.onOutputChunk(chunk, "stdout");
            return { code: 0, signal: null, killed: false, termination: "exit" };
          }
          export const runUtf8CommandWithTimeout = runCommandWithTimeout;
        `,
      };
    }
    return nextLoad(url, context);
  },
});
const { runCommandBuffered } = await import("../../src/process/exec.js");
hook.deregister();
const run = () => runCommandBuffered(["synthetic-git", "cat-file", "--batch"]);
for (let i = 0; i < 100; i++) {
  await run();
}
global.gc();
const initialMemory = process.memoryUsage();
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
let copiedBytes = 0;
let concatenatedBytes = 0;
const allocate = Buffer.allocUnsafeSlow.bind(Buffer);
const concatenate = Buffer.concat.bind(Buffer);
Buffer.allocUnsafeSlow = (size) => {
  copiedBytes += size;
  return allocate(size);
};
Buffer.concat = (chunks, totalLength) => {
  const length = totalLength ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  concatenatedBytes += length;
  return concatenate(chunks, totalLength);
};
const cpu = process.threadCpuUsage();
const started = performance.now();
try {
  for (let i = 0; i < iterations; i++) {
    const result = await run();
    assert.equal(result.stdout.length, 256 * 1024);
    assert.equal(result.stdout[0], 255);
    assert.equal(result.stdout.at(-1), 255);
    assert.equal(result.stderr.length, 0);
    assert.equal(result.termination, "exit");
  }
} finally {
  Buffer.allocUnsafeSlow = allocate;
  Buffer.concat = concatenate;
}
const elapsedMs = performance.now() - started;
const usedCpu = process.threadCpuUsage(cpu);
const { profile } = await inspector.post("HeapProfiler.stopSampling");
global.gc();
global.gc();
console.log(
  JSON.stringify({
    node: process.version,
    iterations,
    outputBytesPerOperation: 256 * 1024,
    elapsedMs,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    nativeBufferBytes: copiedBytes + concatenatedBytes,
    intermediateCopyBytes: copiedBytes,
    sampledJsBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
    initialMemory,
    retainedMemory: process.memoryUsage(),
    load: loadavg(),
  }),
);
inspector.disconnect();
