import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildOkxOrderProposalGate } from "./openclaw-okx-order-proposal-gate.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:order-proposal"],
  "node scripts/openclaw-okx-order-proposal-gate.mjs --write-state --json",
);
assert.equal(
  scripts["okx:order-proposal:check"],
  "node scripts/check-openclaw-okx-order-proposal-gate.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-order-proposal-gate-latest.json",
);
const report = await buildOkxOrderProposalGate();

assert.equal(report.schema, "openclaw.okx.order-proposal-gate.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "dry_run_proposal_only");
assert.ok(
  ["dry_run_proposal_ready_for_manual_review", "dry_run_proposal_blocked"].includes(report.code),
);
assert.ok(["proposal_ready_no_policy_block", "blocked"].includes(report.status));
assert.equal(
  report.dependsOn.apiStatusGate,
  "reports/hermes-agent/state/openclaw-okx-api-status-gate-latest.json",
);
assert.equal(
  report.dependsOn.paperSignalGate,
  "reports/hermes-agent/state/openclaw-okx-paper-signal-gate-latest.json",
);
assert.equal(report.dependsOn.apiStatusSchema, "openclaw.okx.api-status-gate.v1");
assert.ok(typeof report.dependsOn.paperSignalSchema === "string");
assert.ok(Array.isArray(report.dependsOn.apiStatusMarkers));
assert.ok(Array.isArray(report.dependsOn.apiStatusBlockers));
assert.equal(report.requestedOrder.profile, "demo");
assert.ok(["spot", "swap", "futures", "option"].includes(report.requestedOrder.market));
assert.ok(typeof report.requestedOrder.instId === "string");
assert.ok(report.requestedOrder.instId.length > 0);
assert.ok(["buy", "sell"].includes(report.requestedOrder.side));
assert.equal(report.requestedOrder.size, "0");
assert.equal(report.requestedOrder.isActionableOrder, false);
assert.ok(typeof report.signalPrefill === "object" && report.signalPrefill !== null);
assert.ok(
  ["paper_signal_top_candidate", "default_fallback", "cli_override"].includes(
    report.signalPrefill.source,
  ),
);
assert.ok(typeof report.signalPrefill.sourceReport === "string");
assert.ok(typeof report.signalPrefill.selectedInstId === "string");
assert.equal(report.quoteContext.readOnly, true);
assert.equal(report.preTradeChecks.apiStatusSchemaOk, true);
assert.equal(report.preTradeChecks.quoteOk, true);
assert.equal(report.preTradeChecks.openclawSkillOk, true);
assert.equal(report.safety.dryRunOnly, true);
assert.equal(report.safety.executionAllowed, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeTradingEnabled, false);
assert.equal(report.safety.withdrawalEnabled, false);
assert.equal(report.safety.orderPlacementEnabled, false);
assert.equal(report.safety.cancelOrderEnabled, false);
assert.equal(report.safety.amendOrderEnabled, false);
assert.equal(report.safety.submittedOrder, false);
assert.equal(report.safety.submissionCommand, "");
assert.equal(report.safety.credentialEchoed, false);
assert.equal(report.safety.storesSecretsInRepo, false);
assert.equal(report.safety.requiresHumanApprovalGateBeforeWrites, true);
assert.equal(report.safety.requiresSeparatePromotionGateBeforeLive, true);
assert.ok(report.commands.executed.every((command) => !/\b(place|cancel|amend)\b/u.test(command)));
assert.ok(report.commands.forbidden.some((command) => command === "okx spot place"));
assert.ok(report.markers.includes("execution_not_enabled"));
assert.ok(report.markers.includes("submission_command_empty"));
assert.ok(report.markers.includes("submitted_order_false"));
assert.ok(Array.isArray(report.rollbackPath));
assert.ok(report.rollbackPath.length >= 3);
assert.match(report.nextSafeTask, /okx:api-status:check|demo-only/u);
assert.match(report.summary_zh_tw, /OKX dry-run/u);

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
    "OKX_ORDER_PROPOSAL_GATE_CHECK=OK",
    `status=${report.status}`,
    `code=${report.code}`,
    `markers=${report.markers.join("/")}`,
    `blockers=${report.blockers.join("/")}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
