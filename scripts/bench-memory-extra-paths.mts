// node --import ./scripts/tsx.mjs scripts/bench-memory-extra-paths.mts <baseline> <candidate>
import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const roots = process.argv.slice(2);
assert.equal(roots.length, 2, "Pass baseline and candidate checkout directories");
const patterns = [
  "*.md",
  "notes/**/*.md",
  "@(logs.cache|scratch)/**/*.md",
  "{notes,archive/deep}/**/*.md",
];
const files = [
  "root.md",
  "notes/team/keep.md",
  "notes/team/deeper/keep.md",
  "logs.cache/keep.md",
  "archive/deep/keep.md",
  "scratch/keep.md",
];
const loaded = await Promise.all(
  roots.map(async (root) => {
    const { normalizeExtraMemoryPathEntries, matchesExtraMemoryPathEntry } = await import(
      pathToFileURL(path.resolve(root, "packages/memory-host-sdk/src/host/internal.ts")).href
    );
    const workspace = path.resolve("memory-extra-path-benchmark");
    const entries = normalizeExtraMemoryPathEntries(
      workspace,
      patterns.map((pattern) => ({ path: ".", pattern })),
    );
    const candidates = files.map((file) => path.join(workspace, file));
    return {
      samples: [] as number[],
      run() {
        let matched = 0;
        const start = performance.now();
        for (let index = 0; index < 50_000; index += 1) {
          if (
            matchesExtraMemoryPathEntry(
              entries[index % entries.length],
              candidates[index % candidates.length],
            )
          ) {
            matched += 1;
          }
        }
        return { matched, milliseconds: performance.now() - start };
      },
    };
  }),
);
const [baseline, candidate] = loaded;
assert.ok(baseline && candidate);
const arms = [baseline, candidate] as const;
arms.forEach((arm) => arm.run());
for (let pair = 0; pair < 5; pair += 1) {
  const before = baseline.run();
  const after = candidate.run();
  assert.equal(before.matched, after.matched);
  baseline.samples.push(before.milliseconds);
  candidate.samples.push(after.milliseconds);
}
console.log(
  JSON.stringify(
    arms.map((arm) => {
      const ordered = arm.samples.toSorted((a, b) => a - b);
      return { samplesMs: arm.samples, medianMs: ordered[2], p95Ms: ordered[4] };
    }),
    null,
    2,
  ),
);
