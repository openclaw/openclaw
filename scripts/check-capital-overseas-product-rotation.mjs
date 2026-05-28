import assert from "node:assert/strict";
import fs from "node:fs";
import { buildCapitalOverseasProductRotation } from "./openclaw-capital-overseas-product-rotation.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function assertSubscriptionListReadback(list, report, sourceName) {
  assert.equal(
    list.schema,
    "openclaw.capital.overseas-subscription-list.v1",
    `${sourceName} schema`,
  );
  assert.equal(
    list.summary.validProductCount,
    report.summary.productCount,
    `${sourceName} product count`,
  );
  assert.equal(list.summary.totalPageCount, report.summary.pageCount, `${sourceName} page count`);
  assert.equal(list.pages.length, report.summary.pageCount, `${sourceName} pages length`);
  assert.equal(list.activePage.size, report.activePage.size, `${sourceName} active page size`);
  assert.deepEqual(
    list.activePage.codes,
    report.activePage.codes,
    `${sourceName} active page codes`,
  );
  assert.ok(
    list.pages.every((page) => page.size > 0 && page.size <= 64),
    `${sourceName} page size <= 64`,
  );
  assert.equal(
    list.energyContractSubscriptionPlan?.schema,
    "openclaw.capital.energy-contract-subscription-plan.v1",
    `${sourceName} energy plan schema`,
  );
  assert.deepEqual(
    list.energyContractSubscriptionPlan?.candidateCodes,
    report.energyContractSubscriptionPlan.candidateCodes,
    `${sourceName} energy candidate readback`,
  );
  const allCodes = list.pages.flatMap((page) => page.codes);
  assert.equal(allCodes.length, list.summary.allCodesCount, `${sourceName} all codes count`);
  assert.equal(new Set(allCodes).size, allCodes.length, `${sourceName} duplicate codes`);
  for (const symbol of ["CN0000", "CL0000", "ES0000", "NQ0000", "GC0000"]) {
    assert.ok(allCodes.includes(symbol), `${sourceName} ${symbol} readback`);
  }
}

const report = await buildCapitalOverseasProductRotation({ repoRoot: process.cwd() });

assert.equal(report.schema, "openclaw.capital.overseas-product-rotation.v1");
assert.equal(report.status, "passed");
assert.equal(report.constraints.maxSkosPageSize, 64);
assert.equal(report.constraints.supportsAllAtOnce, false);
assert.equal(report.constraints.rotationRequired, true);
assert.equal(report.safety.loginAttemptedByThisScript, false);
assert.equal(report.safety.subscriptionAttemptedByThisScript, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(
  report.energyContractSubscriptionPlan.schema,
  "openclaw.capital.energy-contract-subscription-plan.v1",
);
assert.equal(report.energyContractSubscriptionPlan.safety.readOnlyPlanOnly, true);
assert.equal(report.energyContractSubscriptionPlan.safety.subscriptionAttemptedByThisScript, false);
assert.equal(report.energyContractSubscriptionPlan.safety.paperStrategyAllowed, false);
assert.equal(report.energyContractSubscriptionPlan.safety.liveTradingEnabled, false);
assert.equal(report.energyContractSubscriptionPlan.safety.writeBrokerOrders, false);
assert.equal(report.energyContractSubscriptionPlan.routeCount, 10);
assert.ok(report.energyContractSubscriptionPlan.candidateCount >= 10);
assert.ok(report.summary.productCount > 64);
assert.ok(report.summary.pageCount > 1);
assert.ok(report.summary.maxPageSize <= 64);
assert.ok(report.activePage.size > 0 && report.activePage.size <= 64);
assert.ok(report.activePage.codes.includes("CN0000"));
assert.ok(report.activePage.codes.includes("CL0000"));
assert.ok(report.activePage.codes.includes("ES0000"));
assert.ok(report.activePage.codes.includes("NQ0000"));
assert.ok(report.activePage.codes.includes("GC0000"));
for (const candidate of report.energyContractSubscriptionPlan.candidateCodes) {
  const symbol = String(candidate);
  assert.ok(report.activePage.codes.includes(symbol), `${symbol} energy candidate must be active`);
}
assert.deepEqual(
  report.priority.missingEnergyContractCandidates,
  [],
  "energy contract candidates must not be displaced from active page",
);
const activeCodes = new Set(report.activePage.codes);
for (const route of report.energyContractSubscriptionPlan.routes) {
  assert.equal(route.paperStrategyAllowed, false, `${route.marketCode} paper strategy gate`);
  assert.equal(route.liveTradingEnabled, false, `${route.marketCode} live trading gate`);
  assert.equal(route.writeBrokerOrders, false, `${route.marketCode} broker write gate`);
  assert.ok(
    route.subscriptionCandidates.length > 0,
    `${route.marketCode} ${route.routingMode} subscription candidates`,
  );
  assert.ok(
    route.subscriptionCandidates.every((symbol) => activeCodes.has(symbol)),
    `${route.marketCode} ${route.routingMode} candidates must be in active page`,
  );
}
const ngCurrent = report.energyContractSubscriptionPlan.routes.find(
  (route) => route.marketCode === "NG" && route.routingMode === "current-month",
);
assert.ok(
  ngCurrent?.subscriptionCandidates.includes("NG2606"),
  "NG current-month exact listed candidate",
);
const clCurrent = report.energyContractSubscriptionPlan.routes.find(
  (route) => route.marketCode === "CL" && route.routingMode === "current-month",
);
assert.ok(
  clCurrent?.routeAlignmentStatus === "listed_selected_symbols",
  "CL current-month should align to listed product-list selected contract",
);
assert.ok(
  clCurrent?.subscriptionCandidates.includes("CL2607"),
  "CL current-month listed candidate",
);
assert.deepEqual(
  report.priority.displacedCurrentSubscribed,
  report.priority.missingCurrentSubscribed,
  "current subscribed displacement must be explicit",
);
if (report.priority.missingCurrentSubscribed.length > 0) {
  assert.equal(
    report.activePage.size,
    64,
    "current subscribed may be displaced only at slot limit",
  );
  assert.ok(
    report.priority.missingCurrentSubscribed.every((symbol) => !activeCodes.has(symbol)),
    "missing current subscribed symbols are outside active page by definition",
  );
}
assert.equal(report.subscriptionList.schema, "openclaw.capital.overseas-subscription-list.v1");
assert.equal(report.subscriptionList.summary.validProductCount, report.summary.productCount);
assert.equal(report.subscriptionList.summary.totalPageCount, report.summary.pageCount);
assert.equal(
  report.subscriptionList.summary.energyContractSubscriptionCandidateCount,
  report.energyContractSubscriptionPlan.candidateCount,
);
assert.equal(report.subscriptionList.pages.length, report.summary.pageCount);
assert.equal(report.subscriptionList.activePage.size, report.activePage.size);
assert.ok(report.subscriptionList.pages.every((page) => page.size > 0 && page.size <= 64));
for (const symbol of ["CN0000", "CL0000", "ES0000", "NQ0000", "GC0000"]) {
  const coverage = report.subscriptionList.coreCoverage.find((item) => item.symbol === symbol);
  assert.equal(
    coverage?.included,
    true,
    `${symbol} must be included in overseas subscription pages`,
  );
}
assert.ok(
  fs.existsSync(report.files.subscriptionListReportPath),
  "OpenClaw subscription list file must exist",
);
assert.ok(
  fs.existsSync(report.files.subscriptionListCapitalPath),
  "CapitalHftService subscription list file must exist",
);
const reportListReadback = readJson(report.files.subscriptionListReportPath);
const capitalListReadback = readJson(report.files.subscriptionListCapitalPath);
assertSubscriptionListReadback(reportListReadback, report, "openclaw-report");
assertSubscriptionListReadback(capitalListReadback, report, "capital-state");

process.stdout.write(
  [
    "CAPITAL_OVERSEAS_PRODUCT_ROTATION_CHECK=OK",
    `status=${report.status}`,
    `productCount=${report.summary.productCount}`,
    `pageCount=${report.summary.pageCount}`,
    `activePageSize=${report.activePage.size}`,
    `backlogPageCount=${report.summary.backlogPageCount}`,
    `energyContractSubscriptionCandidateCount=${report.energyContractSubscriptionPlan.candidateCount}`,
    `subscriptionListSchema=${report.subscriptionList.schema}`,
    `reportListReadback=ok`,
    `capitalListReadback=ok`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
