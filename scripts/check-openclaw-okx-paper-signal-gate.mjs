import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildOkxPaperSignalGate } from "./openclaw-okx-paper-signal-gate.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:paper-signal"],
  "node scripts/openclaw-okx-paper-signal-gate.mjs --write-state --json",
);
assert.equal(
  scripts["okx:paper-signal:check"],
  "node scripts/check-openclaw-okx-paper-signal-gate.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-paper-signal-gate-latest.json",
);
const report = await buildOkxPaperSignalGate({
  staleThresholdMs: 15000,
  autoWarmupLoop: true,
});

assert.equal(report.schema, "openclaw.okx.paper-signal-gate.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "paper_only_strategy_signal");
assert.ok(
  ["paper_signal_ready", "paper_signal_ready_with_policy_warnings", "blocked_or_degraded"].includes(
    report.status,
  ),
);
assert.ok(Array.isArray(report.blockers));
assert.ok(Array.isArray(report.policyWarnings));
assert.equal(
  report.dependsOn.loopReport,
  "reports/hermes-agent/state/openclaw-okx-market-snapshot-loop-latest.json",
);
assert.equal(report.dependsOn.apiStatusSchema, "openclaw.okx.api-status-gate.v1");
assert.equal(report.dependsOn.orderProposalSchema, "openclaw.okx.order-proposal-gate.v1");
assert.equal(report.cadence.expectedIntervalMs, 1000);
assert.ok(report.cadence.latestTickDurationMs >= 0);
assert.ok(report.signal.topCandidates.length <= 8);
assert.ok(["paper_hold", "paper_watch_long", "paper_watch_short"].includes(report.signal.action));
if (report.signal.topCandidates.length > 0) {
  const first = report.signal.topCandidates[0];
  assert.ok(first.instId.length > 0);
  assert.ok(first.score >= 0 && first.score <= 100);
  assert.ok(
    ["paper_long_candidate", "paper_short_candidate", "paper_neutral_watch"].includes(first.signal),
  );
}
assert.equal(report.safety.paperOnly, true);
assert.equal(report.safety.readOnly, true);
assert.equal(report.safety.executionAllowed, false);
assert.equal(report.safety.orderPlacementEnabled, false);
assert.equal(report.safety.submittedOrder, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeTradingEnabled, false);
assert.equal(report.safety.withdrawalEnabled, false);
assert.equal(report.safety.credentialEchoed, false);
assert.equal(report.safety.storesSecretsInRepo, false);
assert.ok(
  report.commands.executed.some((value) => value.includes("market-snapshot-loop-latest.json")),
);
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.match(report.summary_zh_tw, /OKX paper signal/u);
assert.ok(Array.isArray(report.rollbackPath));
assert.ok(report.rollbackPath.length >= 3);
assert.match(report.nextSafeTask, /dry-run|loop blocker/u);

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const payload = `${JSON.stringify(report, null, 2)}\n`;
await fs.writeFile(reportPath, payload, "utf8");
await fs.writeFile(
  `${reportPath}.sha256`,
  `${crypto.createHash("sha256").update(payload).digest("hex").toUpperCase()}\n`,
  "ascii",
);

process.stdout.write(
  [
    "OKX_PAPER_SIGNAL_GATE_CHECK=OK",
    `status=${report.status}`,
    `action=${report.signal.action}`,
    `topCount=${report.signal.topCandidates.length}`,
    `blockers=${report.blockers.join("/")}`,
    `policyWarnings=${report.policyWarnings.join("/")}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
