/**
 * Real-process companion to git-buffer-capture-measure.ts. Run the same script
 * on each head, with an optional synthetic Git fixture, one process per sample.
 * node --import ./scripts/tsx.mjs scripts/perf/git-buffer-command-measure.ts [gitDir]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadavg } from "node:os";
import { runCommandBuffered } from "../../src/process/exec.js";
import { runWithSpawnBroker } from "../../src/process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../src/process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../../src/process/spawn-broker/pipe.js";

const MiB = 1024 ** 2;
const producer = `
  const { once } = require("node:events");
  const block = Buffer.alloc(64 * 1024, 165);
  (async () => {
    for (let remaining = Number(process.argv[1]); remaining > 0; remaining -= block.length) {
      if (!process.stdout.write(block.subarray(0, remaining))) {
        await once(process.stdout, "drain");
      }
    }
  })().catch(() => { process.exitCode = 1; });
`;
const cases = [
  { size: 1024, cap: 20 * MiB, repetitions: 64 },
  { size: MiB, cap: 20 * MiB, repetitions: 32 },
  { size: 20 * MiB, cap: 20 * MiB, repetitions: 12 },
  { size: 20 * MiB, cap: 16 * MiB, repetitions: 12 },
  { size: 20 * MiB, cap: 1024, repetitions: 32 },
].map(({ size, cap, repetitions }) => ({
  name: `${size}/${cap}`,
  argv: [process.execPath, "-e", producer, String(size)],
  cap,
  repetitions,
  expected: Buffer.alloc(Math.min(size, cap), 165),
  truncated: size > cap,
}));
if (process.argv[2]) {
  const argv = ["git", "-C", process.argv[2], "ls-tree", "-r", "-l", "-z", "HEAD"];
  cases.push({
    name: "git-ls-tree",
    argv,
    cap: 64 * MiB,
    repetitions: 8,
    expected: execFileSync("git", argv.slice(1), { maxBuffer: 64 * MiB }),
    truncated: false,
  });
}
assert(supportsSpawnBrokerCommandTransport(), "Run on Node with POSIX pipe handles");
const broker = createSpawnBrokerHost();
try {
  await broker.ready();
  await runWithSpawnBroker(broker, async () => {
    for (const { name, argv, cap, repetitions, expected, truncated } of cases) {
      const run = () => runCommandBuffered(argv, { maxOutputBytes: cap, timeoutMs: 30_000 });
      const verify = (result: Awaited<ReturnType<typeof run>>) => {
        assert.equal(result.code, truncated ? null : 0);
        assert.equal(result.termination, truncated ? "output-limit" : "exit");
        assert.equal(result.outputLimitStream, truncated ? "stdout" : undefined);
        assert.equal(result.stderr.length, 0);
        assert(result.stdout.equals(expected));
      };
      for (let i = 0; i < 3; i++) {
        verify(await run());
      }

      const cpu = process.threadCpuUsage();
      const start = performance.now();
      let last = await run();
      for (let i = 1; i < repetitions; i++) {
        last = await run();
      }
      const wallMs = (performance.now() - start) / repetitions;
      const { user, system } = process.threadCpuUsage(cpu);
      verify(last);

      // Keep stack inspection out of the timing sample. Positive concat lengths
      // count bytes copied into the new contiguous Buffer, excluding pipe reads.
      const capture = { calls: 0, bytes: 0, chunks: 0, clippedBytes: 0, concatNs: 0 };
      const { concat: concatDescriptor, allocUnsafeSlow: allocateDescriptor } =
        Object.getOwnPropertyDescriptors(Buffer);
      const concat = concatDescriptor.value;
      const allocate = allocateDescriptor.value;
      assert(concat && allocate);
      const countRuns = 5;
      Buffer.concat = (chunks, length) => {
        const owned = new Error().stack?.includes("at capturedOutput ");
        const before = performance.now();
        const result = concat(chunks, length);
        if (owned) {
          capture.concatNs += (performance.now() - before) * 1e6;
          capture.calls++;
          capture.bytes += result.length;
          capture.chunks += chunks.length;
        }
        return result;
      };
      Buffer.allocUnsafeSlow = (size) => {
        if (new Error().stack?.includes("at appendCapturedOutput ")) {
          capture.clippedBytes += size;
        }
        return allocate(size);
      };
      try {
        for (let i = 0; i < countRuns; i++) {
          verify(await run());
        }
      } finally {
        Buffer.concat = concat;
        Buffer.allocUnsafeSlow = allocate;
      }
      console.log(
        JSON.stringify({
          name,
          repetitions,
          countRuns,
          outputBytes: expected.length,
          ...capture,
          wallMs,
          cpuMs: (user + system) / 1000 / repetitions,
          load: loadavg(),
        }),
      );
    }
  });
} finally {
  await broker.close();
}
