import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildCapitalOverseasStaleRecovery,
  evaluateOverseasStaleRecoveryPolicy,
  runOverseasStaleRecoverySimulation,
} from "./openclaw-capital-overseas-stale-recovery.mjs";

const CHECK_REPORT_PATH = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-overseas-stale-recovery-check-latest.json",
);

function fakeMatrix(symbol = "CN0000") {
  return {
    schema: "openclaw.capital.core-product-freshness-matrix.v1",
    products: [
      {
        id: "a50-hot",
        market: "overseas",
        label: "A50 hot month",
        ready: true,
        status: "fresh_matched",
        subscribed: true,
        matchedSymbol: "CN0000",
        aliases: [{ symbol, subscribed: true, seen: true }],
        diagnostic: {},
      },
    ],
  };
}

function fakeRisk(overrides = {}) {
  return {
    exists: true,
    value: {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      ...overrides,
    },
  };
}

function fakeStatus(overrides = {}) {
  return {
    exists: true,
    value: {
      osQuoteConnected: true,
      subscribedOsStocks: ["CN0000"],
      ...overrides,
    },
  };
}

function fakePlan(overseasStocks = ["CN0000"]) {
  return {
    exists: true,
    value: { overseasStocks },
  };
}

function assertPolicyGuards() {
  const capitalRoot = "D:\\群益及元大API\\CapitalHftService";
  const launcherPath = path.join(capitalRoot, "run-capital-live-readiness-no-order.ps1");
  const badSymbol = evaluateOverseasStaleRecoveryPolicy({
    matrix: fakeMatrix("CN0000"),
    riskControls: fakeRisk(),
    hftStatus: fakeStatus(),
    subscriptionPlan: fakePlan(),
    capitalRoot,
    launcherPath,
    targets: ["OJO05"],
    executeIfSafe: true,
  });

  assert.equal(badSymbol.status, "blocked_invalid_overseas_symbol_format");
  assert.equal(badSymbol.recoveryAllowed, false);
  assert.equal(badSymbol.safety.sentOrder, false);
  assert.equal(badSymbol.safety.brokerWriteAttempted, false);

  const riskArmed = evaluateOverseasStaleRecoveryPolicy({
    matrix: fakeMatrix("CN0000"),
    riskControls: fakeRisk({ allowLiveTrading: true }),
    hftStatus: fakeStatus(),
    subscriptionPlan: fakePlan(),
    capitalRoot,
    launcherPath,
    targets: ["CN0000"],
    executeIfSafe: true,
  });

  assert.equal(riskArmed.status, "blocked_risk_controls_armed");
  assert.equal(riskArmed.recoveryAllowed, false);

  const runtimeEmptySubscription = evaluateOverseasStaleRecoveryPolicy({
    matrix: fakeMatrix("CN0000"),
    riskControls: fakeRisk(),
    hftStatus: fakeStatus({ osQuoteConnected: false, subscribedOsStocks: [] }),
    subscriptionPlan: fakePlan(["CN0000"]),
    capitalRoot,
    launcherPath,
    targets: ["CN0000"],
    executeIfSafe: false,
  });

  assert.equal(runtimeEmptySubscription.status, "blocked_targets_not_subscribed");
  assert.equal(
    runtimeEmptySubscription.runtimeSubscription.reasonCode,
    "os_quote_runtime_not_connected",
  );
  assert.equal(runtimeEmptySubscription.runtimeSubscription.subscribedOsStockCount, 0);
  assert.deepEqual(runtimeEmptySubscription.runtimeSubscription.missingSubscribedTargets, [
    "CN0000",
  ]);
  assert.equal(runtimeEmptySubscription.runtimeSubscription.targetPlanStatus.CN0000, true);
  assert.equal(runtimeEmptySubscription.runtimeSubscription.targetRuntimeStatus.CN0000, false);
}

async function main() {
  const repoRoot = process.cwd();
  const simulation = runOverseasStaleRecoverySimulation(500);
  assert.equal(simulation.requestedRuns, 500);
  assert.equal(simulation.passed, true);
  assert.equal(simulation.failedCases, 0);
  assertPolicyGuards();

  const report = await buildCapitalOverseasStaleRecovery({
    repoRoot,
    targets: ["CN0000", "CD0000", "CL0000"],
    simulateRuns: 500,
  });

  assert.equal(report.schema, "openclaw.capital.overseas-stale-recovery.v1");
  assert.equal(report.loginAttempted, false);
  assert.equal(report.liveTradingEnabled, false);
  assert.equal(report.writeTradingEnabled, false);
  assert.equal(report.sentOrder, false);
  assert.equal(report.safety.sentOrder, false);
  assert.equal(report.safety.brokerWriteAttempted, false);
  assert.equal(report.safety.readCredentials, false);
  assert.equal(report.safety.outputCredentials, false);
  assert.deepEqual(report.targetSummary.requested, ["CN0000", "CD0000", "CL0000"]);
  assert.ok(report.runtimeSubscription);
  assert.equal(Array.isArray(report.runtimeSubscription.planOverseasStocks), true);
  assert.equal(Array.isArray(report.runtimeSubscription.subscribedOsStocks), true);
  assert.equal(Array.isArray(report.runtimeSubscription.missingSubscribedTargets), true);
  assert.equal(typeof report.runtimeSubscription.reasonCode, "string");
  assert.equal(typeof report.runtimeSubscription.probableCause, "string");
  assert.equal(typeof report.runtimeSubscription.operatorAction, "string");
  assert.equal(report.simulation.requestedRuns, 500);
  assert.equal(report.simulation.passed, true);

  const checkReportPath = path.join(repoRoot, CHECK_REPORT_PATH);
  await fs.mkdir(path.dirname(checkReportPath), { recursive: true });
  await fs.writeFile(
    checkReportPath,
    `${JSON.stringify(
      {
        schema: "openclaw.capital.overseas-stale-recovery-check.v1",
        generatedAt: new Date().toISOString(),
        status: "PASS",
        recoveryStatus: report.status,
        recoveryReady: report.ready,
        blockerCode: report.blockerCode,
        safety: report.safety,
        simulation,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.access(checkReportPath);

  process.stdout.write(
    `CAPITAL_OVERSEAS_STALE_RECOVERY_CHECK=OK status=${report.status} ready=${report.ready} blocker=${report.blockerCode || "none"}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `CAPITAL_OVERSEAS_STALE_RECOVERY_CHECK=FAIL ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
