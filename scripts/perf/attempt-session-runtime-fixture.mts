// Add the active worktree after completing the synthetic 35 GiB transcript fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

assert(process.argv[2], "Expected a completed synthetic fixture directory");
const root = path.resolve(process.argv[2]);
const summaryPath = path.join(root, "team-shape-summary.json");
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
assert(
  summary.format === "openclaw-team-shape-v1" &&
    summary.sessionCount === 5000 &&
    summary.completion?.completed === true &&
    summary.projectWorktrees.length === 0,
  "Expected a completed synthetic fixture without projects",
);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const { seedTeamShapeExtras } = await import("./team-shape-extras.ts");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
try {
  const extras = await seedTeamShapeExtras({
    stateDir: root,
    sessions: [],
    retainedRuns: 0,
    approvals: 0,
    cronJobs: 0,
    projects: 1,
    worktreeFiles: 62000,
    worktreeFileBytes: 18432,
    now: summary.now,
  });
  fs.writeFileSync(summaryPath, JSON.stringify({ ...summary, ...extras }, null, 2));
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
