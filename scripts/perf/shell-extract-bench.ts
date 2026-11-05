// Warm public shell explanation, including parsing, argv/risk extraction and wrapper offsets.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/shell-extract-bench.ts
//   --mode timing --iterations 2000 [--module /absolute/path/to/extract.ts]
// Run baseline/candidate in alternating order; use a separate --mode allocation pass.
// Allocation sampling includes collected objects. The corpus fingerprint covers complete
// outputs (argv, spans, risks, operators), while the timed loop only consumes counts.
// Synthetic exec-tool inputs only; this measures the owner, not Gateway RPC latency.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CommandExplanation } from "../../src/infra/command-explainer/types.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    module: { type: "string", default: "src/infra/command-explainer/extract.ts" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
assert(global.gc, "Run with --expose-gc");
const { explainShellCommand } = (await import(pathToFileURL(resolve(values.module)).href)) as {
  explainShellCommand: (source: string) => Promise<CommandExplanation>;
};
const corpus = [
  "git status --short && git diff --stat -- src/infra/command-explainer/extract.ts",
  'git log -12 --format="%h %s" -- "src/example path/文件.ts"',
  "node scripts/run-vitest.mjs src/infra/example.test.ts --maxWorkers=1",
  `rg --fixed-strings '${"synthetic allocation text ".repeat(64)}' ./fixtures`,
  String.raw`printf '%s\n' escaped\ word "double \\"quoted\\"" $'unicode \u263a \U0001f980'`,
  String.raw`bash -lc "printf '%s\\n' 'hello world' && git status --short"`,
  "timeout 10 sh -c 'git diff --name-only | head -20'",
  "cat <<'EOF'\nsynthetic heredoc $text \\ quote \" 🦞\nEOF",
];
const fingerprint = createHash("sha256");
const equivalenceCorpus = [
  ...corpus,
  'bash -c"echo hi"',
  `bash -c 'echo '"hi"`,
  `bash -c 'sh -c "echo hello"'`,
  String.raw`bash -c $'printf \\U00110000 \\uZ \\q'`,
  String.raw`printf $'\U00110000' $'\uZ' $'\q'`,
  String.raw`echo "$VALUE" \$VALUE ${"${OTHER}"} $(printf hello)`,
  'bash -c "echo a\\\nb"',
  'bash -c "echo a\\\r\nb"',
  'bash -c "echo a\\\rb"',
  "printf '🦞' $'\\U0001f980' 'é' '\ud800'",
];
for (const source of equivalenceCorpus) {
  fingerprint.update(JSON.stringify(await explainShellCommand(source)));
}
let commands = 0;
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    const explanation = await explainShellCommand(corpus[index % corpus.length]!);
    commands += explanation.topLevelCommands.length + explanation.nestedCommands.length;
  }
}
await run(1000);
commands = 0;
global.gc();
await nextTurn();
const gcPauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcPauses.push(entry.duration);
  }
});
const inspector = new Session();
try {
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  const start = performance.now();
  await run(iterations);
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const usedThread = process.threadCpuUsage(threadCpu);
  const memoryAfter = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      iterations,
      corpusSize: corpus.length,
      equivalenceCorpusSize: equivalenceCorpus.length,
      fingerprint: fingerprint.digest("hex"),
      commands,
      node: process.version,
      hostLoad,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      mainThreadCpuMs: (usedThread.user + usedThread.system) / 1000,
      sampledBytes,
      bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gc:
        values.mode === "timing"
          ? {
              count: gcPauses.length,
              totalMs: gcPauses.reduce((sum, value) => sum + value, 0),
              maxMs: Math.max(0, ...gcPauses),
            }
          : undefined,
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
}
