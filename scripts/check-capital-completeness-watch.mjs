#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalCompletenessWatch } from "./openclaw-capital-completeness-watch.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");

const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["capital:completeness-watch"],
  "node scripts/openclaw-capital-completeness-watch.mjs",
);
assert.equal(
  scripts["capital:completeness-watch:once"],
  "node scripts/openclaw-capital-completeness-watch.mjs --once --json",
);
assert.equal(
  scripts["check:capital:completeness-watch"],
  "node scripts/check-capital-completeness-watch.mjs",
);

const tempStateDir = path.join(repoRoot, ".openclaw", "tmp", "capital-completeness-watch-check");
const { latest, latestPath, runsPath } = await runCapitalCompletenessWatch({
  repoRoot,
  argv: ["--once", "--state-dir", tempStateDir, "--json"],
});

assert.equal(latest.schema, "openclaw.capital.completeness-watch.v1");
assert.equal(latest.readOnly, true);
assert.equal(latest.allowLiveTrading, false);
assert.equal(latest.writeBrokerOrders, false);
assert.equal(latest.success, true);
assert.equal(typeof latest.status, "string");
assert.ok(["paper_ready_live_blocked", "blocked"].includes(latest.status));
assert.ok(Number.isFinite(Number(latest.durationMs)));
assert.ok(typeof latest.nextSafeTask === "string");
assert.ok(typeof latest.blockerSummary === "string");
assert.notEqual(latest.blockerSummary.trim(), "");
assert.equal(latest.command, "node scripts/check-capital-completeness-report.mjs");
assert.equal(Number.isInteger(latest.consecutiveFailureCount), true);
assert.ok(latest.consecutiveFailureCount >= 0);
if (latest.success) {
  assert.equal(latest.consecutiveFailureCount, 0);
  assert.equal(typeof latest.lastSuccessAt, "string");
  assert.notEqual(latest.lastSuccessAt.trim(), "");
}

await fs.access(latestPath);
await fs.access(`${latestPath}.sha256`);
await fs.access(runsPath);

process.stdout.write(
  [
    "CAPITAL_COMPLETENESS_WATCH_CHECK=OK",
    `status=${latest.status}`,
    `unfinished=${latest.unfinished}`,
    `success=${latest.success}`,
  ].join("\n") + "\n",
);
