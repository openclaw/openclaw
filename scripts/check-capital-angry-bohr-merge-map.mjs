import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildAngryBohrMergeMap,
  writeAngryBohrMergeMap,
} from "./openclaw-capital-angry-bohr-merge-map.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["capital:angry-bohr:merge-map"],
  "node scripts/openclaw-capital-angry-bohr-merge-map.mjs --write-state --json",
);
assert.equal(
  scripts["capital:angry-bohr:merge-map:check"],
  "node scripts/check-capital-angry-bohr-merge-map.mjs",
);

const report = await buildAngryBohrMergeMap();

assert.equal(report.schema, "openclaw.capital.angry-bohr-merge-map.v1");
assert.equal(report.readOnly, true);
assert.equal(report.liveTradingEnabled, false);
assert.equal(report.writeTradingEnabled, false);
assert.equal(report.liveWritePromotionGate.status, "blocked");
assert.equal(report.liveWritePromotionGate.enabled, false);
assert.equal(report.liveWritePromotionGate.blockerCode, "LIVE_WRITE_FORBIDDEN_IN_AUTOMATION");
assert.deepEqual(report.liveWritePromotionGate.deniedCapabilities, [
  "live_api",
  "send_order",
  "external_write",
]);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.allowLiveTrading, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.productRouteGuard.canonicalRoutes.txCurrentMonth, "TX06AM");
assert.equal(report.productRouteGuard.canonicalRoutes.a50Overseas, "CN0000");
assert.deepEqual(report.productRouteGuard.forbiddenActiveRoutes, ["TX05AM", "OJO05", "FA5005"]);
assert.ok(
  report.productRouteGuard.blockedFindings.every(
    (finding) => finding.classification === "do_not_absorb_active_route",
  ),
  "obsolete product routes must only be blocked from active absorption",
);
assert.ok(
  report.productRouteGuard.referenceOnlyFindings.some((finding) =>
    finding.path.includes("OsQuoteFeed.mjs"),
  ),
  "CN0000/overseas mapping may only be treated as reference-only",
);
assert.equal(report.source.branch, "claude/angry-bohr-619b69");
assert.equal(report.source.worktreeExists, true);
assert.equal(report.ready, true);
assert.equal(report.status, "ready");
assert.equal(report.safety.dangerousAbsorbCount, 0);
assert.ok(report.summary.totalDiffPaths > 0);
assert.equal(report.changeDetection.committedCount, report.summary.totalDiffPaths);
assert.ok(report.changeDetection.committedFingerprint.length === 64);
assert.ok(report.changeDetection.dirtyFingerprint.length === 64);
assert.ok(report.changeDetection.combinedFingerprint.length === 64);
assert.equal(typeof report.changeDetection.fingerprintMatchesPrevious, "boolean");
assert.equal(typeof report.changeDetection.noOpRecommended, "boolean");
assert.ok(
  ["blocked", "advance_next_safe_task", "no_op", "refresh_absorption_then_select_next"].includes(
    report.actionPlan.recommendation,
  ),
);
assert.equal(typeof report.actionPlan.shouldRefreshAbsorption, "boolean");
assert.equal(typeof report.actionPlan.shouldAdvanceNextSafeTask, "boolean");
if (
  report.changeDetection.fingerprintMatchesPrevious &&
  report.nextSafeTask.includes("requires_adapter")
) {
  assert.equal(report.actionPlan.recommendation, "advance_next_safe_task");
  assert.equal(report.actionPlan.shouldRefreshAbsorption, false);
  assert.equal(report.actionPlan.shouldAdvanceNextSafeTask, true);
  assert.equal(report.changeDetection.noOpRecommended, false);
}
assert.ok(Array.isArray(report.dirty.items));
assert.equal(report.dirty.totalPaths, report.dirty.items.length);
const agentsDirty = report.dirty.items.find((item) => item.raw.includes("AGENTS.md"));
if (agentsDirty) {
  assert.equal(agentsDirty.path, "AGENTS.md");
}
assert.equal(
  scripts["capital-hft:strategy:arbitrage-base:check"],
  "node scripts/check-capital-strategy-arbitrage-base.mjs",
);
assert.equal(
  scripts["capital-hft:strategy:calendar-spread:check"],
  "node scripts/check-capital-strategy-calendar-spread.mjs",
);
assert.equal(
  scripts["capital-hft:strategy:cross-exchange:check"],
  "node scripts/check-capital-strategy-cross-exchange-arbitrage.mjs",
);
assert.equal(
  scripts["capital-hft:strategy:funding-rate:check"],
  "node scripts/check-capital-strategy-funding-rate-arbitrage.mjs",
);
assert.equal(
  scripts["capital-hft:strategy:futures-cash:check"],
  "node scripts/check-capital-strategy-futures-cash-arbitrage.mjs",
);
assert.equal(
  scripts["capital-hft:strategy:pairs-trading:check"],
  "node scripts/check-capital-strategy-pairs-trading.mjs",
);

for (const category of [
  "absorb_now",
  "already_replaced",
  "covered_by_existing",
  "requires_adapter",
  "blocked_runtime",
  "do_not_merge",
]) {
  assert.ok(Array.isArray(report.categories[category]), `${category} must be an array`);
  assert.equal(report.summary.categories[category], report.categories[category].length);
  assert.equal(
    report.dirty.categories[category],
    report.dirty.items.filter((item) => item.category === category).length,
  );
}
if (report.summary.categories.absorb_now === 0) {
  assert.equal(
    report.nextSafeTask.includes("Review absorb_now"),
    false,
    "nextSafeTask must not point at absorb_now after the absorb list is closed",
  );
  assert.match(report.nextSafeTask, /requires_adapter|blocked_runtime|No merge-map action/u);
  assert.equal(
    report.nextSafeTask.includes("scripts/check-capital-hft-service.mjs"),
    false,
    "nextSafeTask must not loop on check-capital-hft-service after it is covered by existing checks",
  );
  assert.equal(
    report.nextSafeTask.includes("scripts/openclaw-strategy-runner.mjs"),
    false,
    "nextSafeTask must not point at openclaw-strategy-runner after it is blocked as a runtime starter",
  );
  assert.equal(
    report.nextSafeTask.includes("scripts/strategy-engine/OrderRouter.mjs"),
    false,
    "nextSafeTask must not point at OrderRouter after it is rejected as an external order command writer",
  );
  assert.equal(
    report.nextSafeTask.includes("scripts/strategy-engine/StrategyEngine.mjs"),
    false,
    "nextSafeTask must not point at StrategyEngine after it is rejected as a live-capable routing loop",
  );
  assert.equal(
    report.nextSafeTask.includes("scripts/strategy-engine/arbitrage/ArbitrageEngine.mjs"),
    false,
    "nextSafeTask must not point at ArbitrageEngine after it is rejected as a live-capable routing loop",
  );
}

const absorbPaths = report.categories.absorb_now.map((item) => item.path);
for (const forbidden of [/send-order/u, /IbAdapter/u, /ib-config/u, /live-risk/u]) {
  assert.equal(
    absorbPaths.some((filePath) => forbidden.test(filePath)),
    false,
  );
}
assert.equal(
  absorbPaths.includes("scripts/strategy-engine/hft/RiskGuard.mjs"),
  false,
  "RiskGuard has IO/timer side effects and must not be absorb_now",
);
assert.equal(
  absorbPaths.includes("scripts/build-capital-hft-service.mjs"),
  false,
  "build-capital-hft-service compiles and copies external runtime DLLs; it must not be absorb_now",
);
assert.equal(
  absorbPaths.includes("scripts/check-capital-hft-service.mjs"),
  false,
  "check-capital-hft-service is superseded by capital:service-status/check and must not duplicate hardcoded external path checks",
);

assert.equal(
  scripts["capital:service-status"],
  "node scripts/openclaw-capital-service-status.mjs --write-state --json",
);
assert.equal(
  scripts["capital:service-status:check"],
  "node scripts/check-capital-service-status.mjs",
);

const coveredByExistingPathSet = new Set(
  report.categories.covered_by_existing.map((item) => item.path),
);
const alreadyReplacedPathSet = new Set(report.categories.already_replaced.map((item) => item.path));
assert.ok(
  coveredByExistingPathSet.has("scripts/check-capital-hft-service.mjs"),
  "check-capital-hft-service must be covered_by_existing because main already has capital:service-status/check",
);
assert.ok(
  coveredByExistingPathSet.has("config/live-risk-positions.json"),
  "live-risk-positions config must be covered_by_existing via read-only live-risk gate",
);
assert.ok(
  coveredByExistingPathSet.has("scripts/build-capital-hft-service.mjs"),
  "build-capital-hft-service must be covered_by_existing via read-only build gate",
);
assert.ok(
  coveredByExistingPathSet.has("scripts/dashboard-demo.mjs"),
  "dashboard-demo must be covered_by_existing via read-only dashboard gate",
);
assert.ok(
  coveredByExistingPathSet.has("scripts/openclaw-strategy-runner.mjs"),
  "openclaw-strategy-runner must be covered_by_existing via read-only strategy-runner gate",
);
assert.ok(
  coveredByExistingPathSet.has("scripts/live-risk-monitor.mjs"),
  "live-risk-monitor must be covered_by_existing via read-only live-risk-monitor gate",
);
assert.ok(
  coveredByExistingPathSet.has("scripts/openclaw-capital-hft-service.mjs"),
  "openclaw-capital-hft-service must be covered_by_existing via read-only hft-service runtime gate",
);
assert.ok(
  coveredByExistingPathSet.has("scripts/strategy-engine/data/CapitalFeed.mjs") ||
    alreadyReplacedPathSet.has("scripts/strategy-engine/data/CapitalFeed.mjs"),
  "CapitalFeed must be covered_by_existing or already_replaced by the current main read-only quote gates",
);
assert.ok(
  coveredByExistingPathSet.has("scripts/strategy-engine/data/OsQuoteFeed.mjs") ||
    alreadyReplacedPathSet.has("scripts/strategy-engine/data/OsQuoteFeed.mjs"),
  "OsQuoteFeed must be covered_by_existing or already_replaced by product-route guard + read-only reportable quote gates",
);

const requiresAdapterPathSet = new Set(report.categories.requires_adapter.map((item) => item.path));
assert.ok(
  alreadyReplacedPathSet.has("scripts/strategy-engine/arbitrage/ArbitrageBase.mjs"),
  "ArbitrageBase is now safely absorbed into main and must not remain in the adapter queue",
);
assert.ok(
  alreadyReplacedPathSet.has("scripts/strategy-engine/arbitrage/CalendarSpreadStrategy.mjs"),
  "CalendarSpreadStrategy is now safely absorbed into main and must not remain in the adapter queue",
);
assert.ok(
  alreadyReplacedPathSet.has(
    "scripts/strategy-engine/arbitrage/CrossExchangeArbitrageStrategy.mjs",
  ),
  "CrossExchangeArbitrageStrategy is now safely absorbed into main and must not remain in the adapter queue",
);
assert.ok(
  alreadyReplacedPathSet.has("scripts/strategy-engine/arbitrage/FundingRateArbitrage.mjs"),
  "FundingRateArbitrage is now safely absorbed into main and must not remain in the adapter queue",
);
assert.ok(
  alreadyReplacedPathSet.has("scripts/strategy-engine/arbitrage/FuturesCashArbitrageStrategy.mjs"),
  "FuturesCashArbitrageStrategy is now safely absorbed into main and must not remain in the adapter queue",
);
assert.equal(
  requiresAdapterPathSet.has("scripts/strategy-engine/arbitrage/ArbitrageBase.mjs"),
  false,
  "ArbitrageBase must not stay in adapter queue after safe local implementation exists",
);
assert.equal(
  requiresAdapterPathSet.has("scripts/strategy-engine/arbitrage/CalendarSpreadStrategy.mjs"),
  false,
  "CalendarSpreadStrategy must not stay in adapter queue after safe local implementation exists",
);
assert.equal(
  requiresAdapterPathSet.has(
    "scripts/strategy-engine/arbitrage/CrossExchangeArbitrageStrategy.mjs",
  ),
  false,
  "CrossExchangeArbitrageStrategy must not stay in adapter queue after safe local implementation exists",
);
assert.equal(
  requiresAdapterPathSet.has("scripts/strategy-engine/arbitrage/FundingRateArbitrage.mjs"),
  false,
  "FundingRateArbitrage must not stay in adapter queue after safe local implementation exists",
);
assert.equal(
  requiresAdapterPathSet.has("scripts/strategy-engine/arbitrage/FuturesCashArbitrageStrategy.mjs"),
  false,
  "FuturesCashArbitrageStrategy must not stay in adapter queue after safe local implementation exists",
);
assert.ok(
  requiresAdapterPathSet.has("scripts/strategy-engine/hft/RiskGuard.mjs") ||
    alreadyReplacedPathSet.has("scripts/strategy-engine/hft/RiskGuard.mjs"),
  "RiskGuard must require an adapter before merge or already be replaced by current main",
);
assert.equal(
  requiresAdapterPathSet.has("scripts/strategy-engine/OrderRouter.mjs"),
  false,
  "OrderRouter writes external order command files and must not stay in adapter queue",
);
assert.equal(
  requiresAdapterPathSet.has("scripts/strategy-engine/StrategyEngine.mjs"),
  false,
  "StrategyEngine creates OrderRouter and routes autoExecute signals, so it must not stay in adapter queue",
);
assert.equal(
  requiresAdapterPathSet.has("scripts/strategy-engine/arbitrage/ArbitrageEngine.mjs"),
  false,
  "ArbitrageEngine writes external logs and routes autoExecute signals, so it must not stay in adapter queue",
);
assert.equal(
  requiresAdapterPathSet.has("scripts/check-capital-hft-service.mjs"),
  false,
  "check-capital-hft-service must not stay in adapter queue after coverage is proven",
);

const blockedRuntimePathSet = new Set(report.categories.blocked_runtime.map((item) => item.path));
assert.equal(
  blockedRuntimePathSet.has("scripts/build-capital-hft-service.mjs"),
  false,
  "build-capital-hft-service must leave blocked_runtime after read-only build gate coverage exists",
);
assert.equal(
  blockedRuntimePathSet.has("scripts/dashboard-demo.mjs"),
  false,
  "dashboard-demo must leave blocked_runtime after read-only dashboard gate coverage exists",
);
assert.equal(
  blockedRuntimePathSet.has("scripts/openclaw-strategy-runner.mjs"),
  false,
  "openclaw-strategy-runner must leave blocked_runtime after read-only strategy-runner gate coverage exists",
);
assert.equal(
  blockedRuntimePathSet.has("scripts/live-risk-monitor.mjs"),
  false,
  "live-risk-monitor must leave blocked_runtime after read-only live-risk-monitor gate coverage exists",
);
assert.equal(
  blockedRuntimePathSet.has("scripts/openclaw-capital-hft-service.mjs"),
  false,
  "openclaw-capital-hft-service must leave blocked_runtime after read-only hft-service runtime gate coverage exists",
);
assert.equal(
  blockedRuntimePathSet.has("scripts/strategy-engine/data/CapitalFeed.mjs"),
  false,
  "CapitalFeed must leave blocked_runtime after read-only reportable quote gate coverage exists",
);
assert.equal(
  blockedRuntimePathSet.has("scripts/strategy-engine/data/OsQuoteFeed.mjs"),
  false,
  "OsQuoteFeed must leave blocked_runtime after product-route guard + read-only quote gate coverage exists",
);

const doNotMergePathSet = new Set(report.categories.do_not_merge.map((item) => item.path));
assert.ok(
  doNotMergePathSet.has("scripts/openclaw-capital-hft-send-order.mjs"),
  "real order sender must be do_not_merge",
);
assert.ok(
  doNotMergePathSet.has("scripts/strategy-engine/OrderRouter.mjs") ||
    alreadyReplacedPathSet.has("scripts/strategy-engine/OrderRouter.mjs"),
  "OrderRouter writes broker command files and must be do_not_merge or already_replaced by current main",
);
assert.ok(
  doNotMergePathSet.has("scripts/strategy-engine/StrategyEngine.mjs") ||
    alreadyReplacedPathSet.has("scripts/strategy-engine/StrategyEngine.mjs"),
  "StrategyEngine routes autoExecute signals through OrderRouter and must be do_not_merge or already_replaced by current main",
);
assert.ok(
  doNotMergePathSet.has("scripts/strategy-engine/arbitrage/ArbitrageEngine.mjs") ||
    alreadyReplacedPathSet.has("scripts/strategy-engine/arbitrage/ArbitrageEngine.mjs"),
  "ArbitrageEngine routes autoExecute spread signals through OrderRouter and must be do_not_merge or already_replaced by current main",
);

const outputs = await writeAngryBohrMergeMap(report);
await fs.access(outputs.reportPath);
await fs.access(outputs.hashPath);

process.stdout.write(
  `capital angry-bohr merge-map check PASS total=${report.summary.totalDiffPaths} ` +
    `absorb_now=${report.summary.categories.absorb_now} ` +
    `covered_by_existing=${report.summary.categories.covered_by_existing} ` +
    `requires_adapter=${report.summary.categories.requires_adapter} ` +
    `blocked_runtime=${report.summary.categories.blocked_runtime} ` +
    `do_not_merge=${report.summary.categories.do_not_merge}\n`,
);
