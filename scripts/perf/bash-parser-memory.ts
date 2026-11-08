// Run from the checkout under test:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/bash-parser-memory.ts \
//   --mode sequential --concurrency 64 --iterations 1 > sequential.jsonl
// Repeat in a fresh process with --mode concurrent to compare retained high-water marks.
// Node 26 reports cumulative V8 allocations without sampling or GC tracing.
// This diagnostic calls production extraction/admission, never executes its synthetic commands,
// and complements the >=10-minute built-Gateway workload rather than replacing it.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { getHeapCodeStatistics, getHeapStatistics } from "node:v8";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "concurrent" },
    concurrency: { type: "string", default: "64" },
    iterations: { type: "string", default: "1" },
    "command-chars": { type: "string", default: "30000" },
  },
});
const mode = values.mode;
if (mode !== "sequential" && mode !== "concurrent") {
  throw new Error("--mode must be sequential or concurrent; compare fresh processes");
}
const integer = (raw: string, label: string, max: number) => {
  const result = parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
  if (result > max) {
    throw new Error(`${label} must be <= ${max}`);
  }
  return result;
};
const concurrency = integer(values.concurrency, "--concurrency", 256);
const iterations = integer(values.iterations, "--iterations", 100);
const commandChars = integer(values["command-chars"], "--command-chars", 120_000);
if (commandChars < 16) {
  throw new Error("--command-chars must be >= 16");
}

function emit(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

type Mapping = {
  start: string;
  end: string;
  permissions: string;
  name: string;
  sizeBytes: number;
  rssBytes: number;
  anonymousBytes: number;
};
function readSmaps(): Mapping[] {
  if (process.platform !== "linux") {
    return [];
  }
  const mappings: Mapping[] = [];
  let current: Mapping | undefined;
  for (const line of readFileSync("/proc/self/smaps", "utf8").split("\n")) {
    const header = line.match(/^([\da-f]+)-([\da-f]+)\s+(\S+)\s+\S+\s+\S+\s+\d+\s*(.*)$/u);
    if (header?.[1] && header[2] && header[3] && header[4] !== undefined) {
      current = {
        start: header[1],
        end: header[2],
        permissions: header[3],
        name: header[4],
        sizeBytes: Number(BigInt(`0x${header[2]}`) - BigInt(`0x${header[1]}`)),
        rssBytes: 0,
        anonymousBytes: 0,
      };
      mappings.push(current);
    } else if (current) {
      const field = line.match(/^(Rss|Anonymous):\s+(\d+) kB$/u);
      if (field) {
        current[field[1] === "Rss" ? "rssBytes" : "anonymousBytes"] = Number(field[2]) * 1024;
      }
    }
  }
  return mappings;
}

type ObservedMemory = {
  memory: WebAssembly.Memory;
  descriptor: WebAssembly.MemoryDescriptor;
  candidateStarts: string[];
};
const memories: ObservedMemory[] = [];
const NativeMemory = WebAssembly.Memory;
WebAssembly.Memory = new Proxy(NativeMemory, {
  construct(Target, args: [WebAssembly.MemoryDescriptor]) {
    const before = new Set(readSmaps().map((mapping) => `${mapping.start}:${mapping.end}`));
    const memory = new Target(...args);
    const candidates = readSmaps().filter(
      (mapping) =>
        !before.has(`${mapping.start}:${mapping.end}`) &&
        mapping.permissions.startsWith("rw") &&
        (mapping.name === "" || mapping.name.startsWith("[anon:")) &&
        mapping.sizeBytes === memory.buffer.byteLength,
    );
    memories.push({
      memory,
      descriptor: args[0],
      candidateStarts: candidates.map((row) => row.start),
    });
    return memory;
  },
});

function snapshot(label: string) {
  global.gc?.();
  const usage = process.memoryUsage();
  const mappings = readSmaps();
  emit({
    kind: "snapshot",
    label,
    memory: usage,
    code: getHeapCodeStatistics(),
    wasm: memories.map(({ memory, descriptor, candidateStarts }) => {
      const matches = mappings.filter((mapping) => candidateStarts.includes(mapping.start));
      const mapping = matches.length === 1 && candidateStarts.length === 1 ? matches[0] : null;
      return {
        descriptor,
        linearBytes: memory.buffer.byteLength,
        // RSS is attributed only when creation revealed one unambiguous anonymous mapping.
        mapping,
        candidateStarts,
      };
    }),
  });
}

function summarize(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return {
    count: sorted.length,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}
emit({
  kind: "configuration",
  node: process.version,
  platform: process.platform,
  mode,
  concurrency,
  iterations,
  commandChars,
  forcedGcBetweenPhases: typeof global.gc === "function",
  smaps: process.platform === "linux",
  latencyNote:
    "p99 requires 1000 samples and p95 requires 200 to gate; smaller samples are context",
});
snapshot("before-import");
const { explainShellCommand } = await import("../../src/infra/command-explainer/extract.js");
const { detectUnsafeExecControlShellCommand } =
  await import("../../src/infra/exec-control-command-guard.js");
snapshot("after-import");
const coldStart = performance.now();
if ((await detectUnsafeExecControlShellCommand("pwd")) !== null) {
  throw new Error("Synthetic first command failed admission");
}
emit({ kind: "first-admission", ms: performance.now() - coldStart });
snapshot("after-first-admission");

async function measure(label: string, operation: () => Promise<void>) {
  global.gc?.();
  const allocationStart = getHeapStatistics().total_allocated_bytes;
  const samples: number[] = [];
  const cpuStart = process.cpuUsage();
  const threadStart = process.threadCpuUsage();
  const started = performance.now();
  const once = async () => {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (mode === "concurrent") {
      await Promise.all(Array.from({ length: concurrency }, once));
    } else {
      for (let index = 0; index < concurrency; index++) {
        await once();
      }
    }
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const threadCpu = process.threadCpuUsage(threadStart);
  const allocationBytes = getHeapStatistics().total_allocated_bytes - allocationStart;
  emit({
    kind: "measurement",
    label,
    elapsedMs,
    operations: samples.length,
    latencyMs: summarize(samples),
    processCpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    v8AllocationBytes: allocationBytes,
    v8AllocationBytesPerOperation: allocationBytes / samples.length,
  });
  snapshot(`after-${label}`);
}

const commands = [
  ["ordinary", "git status --short && printf '%s\\n' synthetic"],
  ["large", `: ${"word ".repeat(Math.floor((commandChars - 7) / 5))}; pwd`],
] as const;
for (const [size, command] of commands) {
  await measure(`${size}-extraction`, async () => {
    const explanation = await explainShellCommand(command);
    if (!explanation.ok || explanation.topLevelCommands.length !== 2) {
      throw new Error(`Synthetic ${size} extraction failed`);
    }
  });
  await measure(`${size}-admission`, async () => {
    if ((await detectUnsafeExecControlShellCommand(command)) !== null) {
      throw new Error(`Synthetic ${size} command failed admission`);
    }
  });
}
snapshot("final");
WebAssembly.Memory = NativeMemory;
