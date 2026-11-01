/**
 * Measure the existing real six-sibling native PR fixture, with every assertion
 * and private handoff guard intact. Darwin/APFS only. Run serially on each arm:
 *   node scripts/perf/native-pr-bootstrap-measure.mjs
 * Alternate baseline/candidate at least five times. PR 42 is cold template
 * creation; PR 43 is warm; 44–47 retain sparse-transition correctness coverage.
 * The diagnostic timeout is separate from the unchanged regression-test budget.
 * Add --counts for a separate traced diagnostic run. Timing acceptance is untraced.
 * --provision-ref <commit> substitutes that committed provisioner and lock owner
 * before the fixture's trusted commit. Other source and the harness stay fixed.
 * --profile-dir <directory> records separate Node CPU profiles, never timing proof.
 * Git Trace2 counts include the native owner checks, not just useful Git commands.
 * Acceptance: fewer unnecessary launches, lower median cold/warm latency, no
 * >=20% regression in either latency cell; report p95/range and host load.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

assert.equal(process.platform, "darwin", "This workload requires real APFS template cloning");
const { values } = parseArgs({
  options: {
    counts: { type: "boolean", default: false },
    "provision-ref": { type: "string", default: "HEAD" },
    "profile-dir": { type: "string" },
  },
});
const provisionRef = execFileSync(
  "git",
  ["rev-parse", "--verify", `${values["provision-ref"]}^{commit}`],
  {
    encoding: "utf8",
  },
).trim();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pr-bootstrap-measure-"));
const measure = path.join(scratch, "flows.jsonl");
const load = os.loadavg();
const provisionSource = path.join(scratch, "provision-source");
const profilePreload = path.join(scratch, "profile.mjs");
try {
  fs.mkdirSync(provisionSource);
  for (const file of ["worktree-provision.mts", "operation-lock.sh"]) {
    fs.writeFileSync(
      path.join(provisionSource, file),
      execFileSync("git", ["show", `${provisionRef}:scripts/pr-lib/${file}`]),
    );
  }
  if (values["profile-dir"]) {
    const directory = path.resolve(values["profile-dir"]);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      profilePreload,
      `
import { Session } from "node:inspector";
import { writeFileSync } from "node:fs";
if (process.argv[1]?.endsWith("/scripts/pr-lib/worktree-provision.mts")) {
  const session = new Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.start");
  process.once("beforeExit", () => session.post("Profiler.stop", (error, result) => {
    if (error) throw error;
    writeFileSync(${JSON.stringify(directory)} + "/" + process.pid + ".cpuprofile", JSON.stringify(result.profile));
    session.disconnect();
  }));
}
`,
    );
  }
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
        OPENCLAW_PR_BOOTSTRAP_TRACE: values.counts ? "1" : "0",
        OPENCLAW_PR_BOOTSTRAP_PROVISION_SOURCE: provisionSource,
        OPENCLAW_PR_BOOTSTRAP_PROFILE: values["profile-dir"] ? profilePreload : "",
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
      provisionRef,
      traced: values.counts,
      profiled: Boolean(values["profile-dir"]),
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
