/**
 * Measure the existing real six-sibling native PR fixture, with every assertion
 * and private handoff guard intact. Darwin/APFS only. Run serially on each arm:
 *   node scripts/perf/native-pr-bootstrap-measure.mjs
 * Alternate baseline/candidate at least five times. PR 42 is cold template
 * creation; PR 43 is warm; 44–47 retain sparse-transition correctness coverage.
 * The diagnostic timeout is separate from the unchanged regression-test budget.
 * Add --counts for a separate traced diagnostic run. Timing acceptance is untraced.
 * Git Trace2 counts include the native owner checks, not just useful Git commands.
 * Acceptance: fewer unnecessary launches, lower median cold/warm latency, no
 * >=20% regression in either latency cell; report p95/range and host load.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

assert.equal(process.platform, "darwin", "This workload requires real APFS template cloning");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pr-bootstrap-measure-"));
const measure = path.join(scratch, "flows.jsonl");
const load = os.loadavg();
const counts = process.argv.slice(2).includes("--counts");
try {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "test/scripts/pr-worktree-provision.test.ts",
      "--testNamePattern",
      "materializes full cold/warm PR siblings",
      "--testTimeout",
      "600000",
      "--maxWorkers",
      "1",
      "--reporter",
      "verbose",
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_PR_BOOTSTRAP_MEASURE: measure,
        OPENCLAW_PR_BOOTSTRAP_TRACE: counts ? "1" : "0",
      },
      stdio: "inherit",
    },
  );
  const flows = fs.existsSync(measure)
    ? fs.readFileSync(measure, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  console.log(
    JSON.stringify({
      workload: "native-pr-bootstrap-six-siblings",
      milliseconds: performance.now() - started,
      traced: counts,
      loadBefore: load,
      loadAfter: os.loadavg(),
      flows,
      status: result.status,
    }),
  );
  assert.equal(result.status, 0, "The complete provisioning fixture must pass");
  assert.equal(flows.filter(({ args }) => args[0] === "review-init").length, 6);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
