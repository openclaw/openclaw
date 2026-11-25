// Run on baseline and candidate with: node --import ./scripts/tsx.mjs scripts/bench-write-diff.ts
// Warm-cache write-tool timings, not model latency or fsync durability. Setup/assertions excluded.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createWriteTool } from "../src/agents/sessions/tools/write.js";

const samples = 40;
const warmups = 8;
const directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-write-bench-"));
const tool = createWriteTool(directory);
const results = [];
try {
  for (const size of [1024, 65536, 1048576, 4194304]) {
    const prefix = "target=0\n";
    const line = "stable synthetic benchmark content 0123456789 abcdefghijklmnopqrstuvwxyz\n";
    const before =
      prefix + line.repeat(Math.ceil(size / line.length)).slice(0, size - prefix.length);
    for (const scenario of ["small-change", "full-rewrite", "noop"] as const) {
      const after =
        scenario === "full-rewrite"
          ? before.replaceAll("stable", "CHANGED").replace("target=0", "target=9")
          : scenario === "small-change"
            ? before.replace("target=0", "target=1")
            : before;
      const file = path.join(directory, "fixture.txt");
      const timings: number[] = [];
      for (let iteration = -warmups; iteration < samples; iteration++) {
        await writeFile(file, before);
        const start = performance.now();
        await tool.execute("bench", { path: "fixture.txt", content: after });
        const elapsed = performance.now() - start;
        assert.equal(await readFile(file, "utf8"), after);
        if (iteration >= 0) {
          timings.push(elapsed);
        }
      }
      const sorted = timings.toSorted((a, b) => a - b);
      results.push({
        size,
        scenario,
        medianMs: sorted[Math.floor(samples / 2)],
        p95Ms: sorted[Math.ceil(samples * 0.95) - 1],
        samplesMs: timings,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        cpu: os.cpus()[0]?.model,
        samples,
        warmups,
        maxRssKiB: process.resourceUsage().maxRSS,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
