import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  addSession,
  appendOutput,
  deleteSession,
  createProcessSession,
  markExited,
  prepareSessionPoll,
  type ProcessSession,
} from "../../src/agents/bash-process-registry.js";
import { chunkString } from "../../src/agents/bash-tools.shared.js";
import {
  createStreamingBinaryOutputSanitizer,
  sanitizeBinaryOutput,
} from "../../src/agents/shell-utils.js";
import { createProcessSupervisor } from "../../src/process/supervisor/supervisor.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

// Measures the production decoder, supervisor, sanitizer and output registry, without a
// Gateway/model. Each completed subprocess is one synthetic exec turn, not a chat turn.
const { values } = parseArgs({
  options: {
    phase: { type: "string", default: "cpu" },
    scenario: { type: "string", default: "burst" },
    turns: { type: "string" },
    concurrency: { type: "string" },
    mib: { type: "string" },
    "chunk-bytes": { type: "string" },
    "start-at": { type: "string" },
    "max-output": { type: "string" },
    "sampling-interval": { type: "string" },
    updates: { type: "boolean", default: false },
    fixture: { type: "string", default: "plain" },
    "sanitizer-module": { type: "string" },
    "verify-against": { type: "string" },
    output: { type: "string" },
  },
});
assert(values.phase === "cpu" || values.phase === "allocation" || values.phase === "buffers");
assert(values.scenario === "burst" || values.scenario === "build");
assert(values.fixture === "plain" || values.fixture === "ansi");
const createSanitizer: typeof createStreamingBinaryOutputSanitizer = values["sanitizer-module"]
  ? (await import(pathToFileURL(values["sanitizer-module"]).href))
      .createStreamingBinaryOutputSanitizer
  : createStreamingBinaryOutputSanitizer;
if (values["verify-against"]) {
  const baseline = await import(pathToFileURL(values["verify-against"]).href);
  const corpus = [
    "plain\ttext\rprogress\n👩‍💻\u200c\u200b\ud800\udc00\ud800",
    "A\x1b]title\x1b\\B\x9dtitle\x07C\x1b[6n\x1b[?1hD\x1b[?1l",
    "A\x1b[6\x07nB\x1b[31\x18mC\x1b[[31mD\x1b(31mE\x1b[unfinished",
  ];
  // Include every Unicode code point, including lone surrogates and C0/C1 controls.
  for (let start = 0; start <= 0x10ffff; start += 4096) {
    corpus.push(
      Array.from({ length: 4096 }, (_, index) => String.fromCodePoint(start + index)).join(""),
    );
  }
  for (const input of corpus) {
    for (const ansiMode of ["standard", "compat"] as const) {
      assert.equal(
        sanitizeBinaryOutput(input, { ansiMode }),
        baseline.sanitizeBinaryOutput(input, { ansiMode }),
      );
    }
    for (const width of [1, 2, 7, 64, 4096]) {
      const controls: string[] = [];
      const expectedControls: string[] = [];
      const sanitize = createStreamingBinaryOutputSanitizer((sequence) => controls.push(sequence));
      const expected = baseline.createStreamingBinaryOutputSanitizer((sequence: string) =>
        expectedControls.push(sequence),
      );
      for (let offset = 0; offset < input.length; offset += width) {
        const chunk = input.slice(offset, offset + width);
        assert.equal(sanitize(chunk), expected(chunk));
      }
      assert.deepEqual(controls, expectedControls);
    }
  }
  console.log(`Verified ${corpus.length} corpus entries against ${values["verify-against"]}`);
}
assert(global.gc, "run with --expose-gc");
function option(
  name:
    | "turns"
    | "concurrency"
    | "mib"
    | "chunk-bytes"
    | "start-at"
    | "max-output"
    | "sampling-interval",
  fallback: number,
  min = 1,
) {
  return parseStrictIntegerOption({ raw: values[name], fallback, label: name, min });
}
const turns = option("turns", values.scenario === "build" ? 1 : 10);
const concurrency = option("concurrency", 1);
const mib = option("mib", 50);
const chunkBytes = option("chunk-bytes", 4096);
const maxOutputChars = option("max-output", 200_000);
const startAt = option("start-at", 0, 0);
const samplingInterval = option("sampling-interval", 524_288);
const bytesPerTurn = mib * 1024 * 1024;
assert(bytesPerTurn % chunkBytes === 0, "output bytes must be divisible by chunk bytes");
const supervisor = createProcessSupervisor();
const inspector = new Session();
let nextId = 0;
let appendCalls = 0;
let decodedCallbacks = 0;
let updateReads = 0;
let outputBytes = 0;
let verifiedCharacters = 0;
let sanitizerMs = 0;
const plainLine = "[build] Compiling synthetic/module.ts ... complete\n";
const line =
  values.fixture === "ansi"
    ? "\x1b[32mPASS\x1b[0m src/example.test.ts (12 tests)\n\r\x1b[2KProgress: resolved 125, reused 120\tadded 5\nnoise:\x00\x07\x7f\n"
    : plainLine;
const cleanLine =
  values.fixture === "ansi"
    ? "PASS src/example.test.ts (12 tests)\n\rProgress: resolved 125, reused 120\tadded 5\nnoise:\\x00\\x07\\x7f\n"
    : plainLine;
const repeats = Math.floor(chunkBytes / line.length);
const padding = " ".repeat(chunkBytes - repeats * line.length);
const sourceChunk =
  values.fixture === "plain"
    ? line.repeat(Math.ceil(chunkBytes / line.length)).slice(0, chunkBytes)
    : line.repeat(repeats) + padding;
const cleanChunk = values.fixture === "plain" ? sourceChunk : cleanLine.repeat(repeats) + padding;

function tails(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: samples.length,
    p95Ms: sorted[Math.ceil(samples.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(samples.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}

async function runTurn(bytes: number, intervalMs: number) {
  const session: ProcessSession = createProcessSession({
    id: `output-measure-${nextId++}`,
    command: "synthetic build output",
    cleanupMs: 60_000,
    startedAt: Date.now(),
    maxOutputChars,
    pendingMaxOutputChars: 30_000,
    totalOutputChars: 0,
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    pendingOutputDropped: false,
    exited: false,
    truncated: false,
    backgrounded: !values.updates,
    cursorKeyMode: "normal",
  });
  addSession(session);
  const sanitize = createSanitizer();
  const childSource = `
    const { once } = require('node:events');
    const { setTimeout: delay } = require('node:timers/promises');
    const chunk = Buffer.from(${JSON.stringify(sourceChunk)});
    (async () => {
      for (let i = 0; i < ${bytes / chunkBytes}; i++) {
        if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
        if (${intervalMs}) await delay(${intervalMs});
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const run = await supervisor.spawn({
      mode: "child",
      argv: [process.execPath, "-e", childSource],
      cwd: process.cwd(),
      captureOutput: false,
      stdinMode: "pipe-closed",
      timeoutMs: 120_000,
      onStdout(data) {
        decodedCallbacks++;
        outputBytes += Buffer.byteLength(data);
        const sanitizeStarted = performance.now();
        const sanitized = sanitize(data);
        sanitizerMs += performance.now() - sanitizeStarted;
        for (const chunk of chunkString(sanitized)) {
          appendOutput(session, "stdout", chunk);
          appendCalls++;
          // Foreground updates read this field after each append in the real exec callback.
          if (values.updates) {
            assert(session.tail.length <= 2000);
            updateReads++;
          }
        }
      },
      onStderr(data) {
        throw new Error(`synthetic producer failed: ${data}`);
      },
    });
    const result = await run.wait();
    await run.waitForExtinction?.();
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, "exit");
    markExited(session, result.exitCode, result.exitSignal, "completed", result.reason);
    const cleanChars = (bytes / chunkBytes) * cleanChunk.length;
    assert.equal(session.totalOutputChars, cleanChars);
    const retainedChars = Math.min(cleanChars, maxOutputChars);
    const repeated = cleanChunk.repeat(Math.ceil(retainedChars / cleanChunk.length) + 1);
    const expected = repeated.slice(-retainedChars);
    assert.equal(session.aggregated, expected);
    assert.equal(session.tail, expected.slice(-2000));
    const poll = prepareSessionPoll(session, undefined);
    assert.equal(poll.output, repeated.slice(-Math.min(cleanChars, 30_000, maxOutputChars)));
    assert.equal(poll.outputDropped, cleanChars > Math.min(30_000, maxOutputChars));
    verifiedCharacters += retainedChars;
  } finally {
    deleteSession(session.id);
  }
}

const pauses = { minor: [] as number[], major: [] as number[], other: [] as number[] };
let started = Infinity;
let ended = Infinity;
function recordGc(entries: PerformanceEntry[]) {
  for (const entry of entries) {
    if (entry.startTime < started || entry.startTime > ended) {
      continue;
    }
    const { kind } = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
    const bucket =
      kind === constants.NODE_PERFORMANCE_GC_MINOR
        ? pauses.minor
        : kind === constants.NODE_PERFORMANCE_GC_MAJOR
          ? pauses.major
          : pauses.other;
    bucket.push(entry.duration);
  }
}

try {
  await runTurn(chunkBytes * 256, 0);
  appendCalls = decodedCallbacks = updateReads = outputBytes = verifiedCharacters = 0;
  sanitizerMs = 0;
  global.gc();
  const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  await delay(10);
  if (values.phase === "allocation") {
    await startCollectedHeapSampling(inspector, samplingInterval);
  }
  if (startAt) {
    assert(startAt > Date.now(), "preparation missed the shared start deadline");
    await delay(startAt - Date.now());
  }
  loop.reset();
  console.log("BASH_OUTPUT_MEASURE_START");
  const startedAtEpochMs = Date.now();
  // This separate diagnostic pass counts JS-requested backing bytes, including
  // pooled allocations. Nested calls (concat -> allocUnsafe) count only once.
  // Native pipe allocations are outside these public Buffer allocation APIs.
  let bufferBytes = 0;
  let bufferAllocations = 0;
  let bufferDepth = 0;
  const restoreBuffers: (() => void)[] = [];
  if (values.phase === "buffers") {
    for (const name of ["from", "alloc", "allocUnsafe", "allocUnsafeSlow", "concat"] as const) {
      const original = Buffer[name];
      Object.defineProperty(Buffer, name, {
        value: new Proxy(original, {
          apply(target, receiver, args) {
            bufferDepth++;
            try {
              const result: Buffer = Reflect.apply(target, receiver, args);
              if (bufferDepth === 1) {
                bufferBytes += result.byteLength;
                bufferAllocations++;
              }
              return result;
            } finally {
              bufferDepth--;
            }
          },
        }),
      });
      restoreBuffers.push(() => Object.defineProperty(Buffer, name, { value: original }));
    }
  }
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const memoryBefore = process.memoryUsage();
  const turnLatencies: number[] = [];
  started = performance.now();
  for (let index = 0; index < turns; index += concurrency) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, turns - index) }, async () => {
        const turnStarted = performance.now();
        await runTurn(bytesPerTurn, values.scenario === "build" ? 1 : 0);
        turnLatencies.push(performance.now() - turnStarted);
      }),
    );
  }
  ended = performance.now();
  for (const restore of restoreBuffers) {
    restore();
  }
  const threadCpu = process.threadCpuUsage(threadBefore);
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  loop.disable();
  console.log("BASH_OUTPUT_MEASURE_END");
  await delay(10);
  recordGc(observer.takeRecords());
  observer.disconnect();
  let allocation: object | undefined;
  if (values.phase === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let totalBytes = 0;
    let registryBytes = 0;
    const sites = new Map<string, number>();
    function visit(node: HeapProfiler.SamplingHeapProfileNode, owned = false) {
      const underRegistry = owned || node.callFrame.functionName === "appendOutput";
      totalBytes += node.selfSize;
      if (underRegistry) {
        registryBytes += node.selfSize;
      }
      if (node.selfSize) {
        const name = node.callFrame.functionName || "(anonymous)";
        sites.set(name, (sites.get(name) ?? 0) + node.selfSize);
      }
      for (const child of node.children) {
        visit(child, underRegistry);
      }
    }
    visit(profile.head);
    allocation = {
      samplingInterval,
      totalBytes,
      registryBytes,
      bytesPerOutputByte: totalBytes / outputBytes,
      registryBytesPerOutputByte: registryBytes / outputBytes,
      bytesPerExecTurn: totalBytes / turns,
      registryShare: registryBytes / totalBytes,
      topSites: [...sites].toSorted((a, b) => b[1] - a[1]).slice(0, 15),
    };
  }
  const totalGcMs = Object.values(pauses)
    .flat()
    .reduce((sum, value) => sum + value, 0);
  const result = {
    phase: values.phase,
    scenario: values.scenario,
    fixture: values.fixture,
    updates: values.updates,
    turns,
    concurrency,
    bytesPerTurn,
    chunkBytes,
    maxOutputChars,
    startedAtEpochMs,
    outputBytes,
    appendCalls,
    decodedCallbacks,
    updateReads,
    verifiedCharacters,
    sanitizerMsPerMiB: sanitizerMs / (outputBytes / 1024 / 1024),
    elapsedMs: ended - started,
    cpuMsPerMiB: (cpu.user + cpu.system) / 1000 / (outputBytes / 1024 / 1024),
    mainThreadCpuMsPerMiB: (threadCpu.user + threadCpu.system) / 1000 / (outputBytes / 1024 / 1024),
    memoryBefore,
    memoryAfter,
    turnLatency: tails(turnLatencies),
    eventLoopDelay: {
      samples: loop.count,
      p95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
      p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
      maxMs: loop.count ? loop.max / 1e6 : null,
    },
    gc: {
      totalMs: totalGcMs,
      msPerMiB: totalGcMs / (outputBytes / 1024 / 1024),
      ...Object.fromEntries(
        Object.entries(pauses).map(([kind, samples]) => [
          kind,
          {
            ...tails(samples),
            totalMs: samples.reduce((sum, value) => sum + value, 0),
          },
        ]),
      ),
    },
    allocation,
    buffers:
      values.phase === "buffers"
        ? {
            allocations: bufferAllocations,
            requestedBytes: bufferBytes,
            bytesPerOutputByte: bufferBytes / outputBytes,
            bytesPerExecTurn: bufferBytes / turns,
          }
        : undefined,
  };
  const json = JSON.stringify(result);
  if (values.output) {
    await writeFile(values.output, `${json}\n`);
  }
  console.log(json);
} finally {
  inspector.disconnect();
  await supervisor.shutdown();
}
