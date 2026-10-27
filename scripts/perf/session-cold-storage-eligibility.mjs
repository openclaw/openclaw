// Counts-only real maintenance proof. Usage and acceptance: scripts/perf/README.md.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "expect-head": { type: "string" },
  },
});
assert(
  values.output && values["expect-head"],
  "Supply --output <new directory> --expect-head <full SHA>",
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = "src/config/sessions/session-cold-storage.externalization.test.ts";
const inputs = [
  fixture,
  "src/config/sessions/session-cold-storage-selection.ts",
  "src/config/sessions/session-cold-storage-worker.ts",
  "scripts/perf/session-cold-storage-eligibility.mjs",
  "scripts/perf/session-cold-storage-eligibility-preload.mjs",
];
const source = () => ({
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  files: Object.fromEntries(
    inputs.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  ),
});
const before = source();
assert.equal(before.head, values["expect-head"], "Unexpected source HEAD");
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
writeFileSync(path.join(output, "source.json"), JSON.stringify(before, null, 2) + "\n");
const countsPath = path.join(output, "counts.jsonl");
const started = performance.now();
const run = spawnSync(process.execPath, ["scripts/test-projects.mts", fixture, "--maxWorkers=1"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  env: {
    ...process.env,
    OPENCLAW_VITEST_RUNTIME: "node",
    OPENCLAW_COLD_ELIGIBILITY_COUNTS: countsPath,
  },
});
writeFileSync(path.join(output, "test.log"), (run.stdout ?? "") + (run.stderr ?? ""));
const result = {
  source: before,
  testExit: run.status,
  commandWallSeconds: (performance.now() - started) / 1000,
};
writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
assert.deepEqual(source(), before, "Source changed during the workload");
if (run.error) {
  throw run.error;
}
assert.equal(
  run.status,
  0,
  "Real maintenance fixture failed; inspect test.log, not a performance verdict",
);

const workloads = { fixture: [], full: [], mixed: [] };
let workload;
for (const line of readFileSync(countsPath, "utf8").trim().split("\n")) {
  const record = JSON.parse(line);
  if (record.workload) {
    workload = record.workload;
  } else {
    assert.equal(record.isMainThread, false);
    workloads[workload].push(record);
  }
}
const summary = Object.fromEntries(
  Object.entries(workloads).map(([name, rows]) => [
    name,
    Object.fromEntries(
      ["selection", "mutation", "admission", "externalization-selection"].map((phase) => [
        phase,
        rows
          .filter((row) => row.phase === phase)
          .reduce(
            (sum, row) => ({
              calls: sum.calls + row.calls,
              rows: sum.rows + row.rows,
              entryBytes: sum.entryBytes + row.entryBytes,
            }),
            { calls: 0, rows: 0, entryBytes: 0 },
          ),
      ]),
    ),
  ]),
);
writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ ...result, summary }, null, 2));
// Positive controls refuse an absent preload or renamed attribution owner, rather than reporting false zero work.
assert.equal(summary.fixture["externalization-selection"].rows, 0);
assert.equal(summary.full["externalization-selection"].rows, 128);
assert.equal(summary.mixed["externalization-selection"].rows, 1);
for (const phase of ["selection", "mutation"]) {
  assert.equal(summary.fixture[phase].calls, 3);
  assert.equal(summary.mixed[phase].calls, 3);
  assert(summary.mixed[phase].entryBytes > 0);
}
assert.equal(summary.full.admission.calls, 4, "Keep preparation and final ownership checks");
assert.equal(summary.mixed.admission.calls, 4);
assert.deepEqual(
  { selection: summary.full.selection.calls, mutation: summary.full.mutation.calls },
  { selection: 0, mutation: 0 },
  "Externalization-only consumers must not read hot eligibility",
);
assert.equal(summary.full.selection.entryBytes + summary.full.mutation.entryBytes, 0);
