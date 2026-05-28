import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCapitalActivePageRefreshPlan } from "./openclaw-capital-active-page-refresh-plan.mjs";

const candidateCodes = [
  "CL2607",
  "CL2608",
  "CL0000",
  "QM2607",
  "QM2608",
  "QM0000",
  "MCL2607",
  "MCL2608",
  "MCL0000",
  "BZ2607",
  "BZ2608",
  "BZ0000",
  "NG2606",
  "NG2607",
  "NG0000",
];

function rotationFixture({ omitCandidate = "" } = {}) {
  const activeCodes = candidateCodes.filter((code) => code !== omitCandidate);
  return {
    schema: "openclaw.capital.overseas-product-rotation.v1",
    status: "passed",
    activePage: {
      size: activeCodes.length,
      codes: activeCodes,
      launchArgs: ["--os-stocks", activeCodes.join(",")],
    },
    energyContractSubscriptionPlan: {
      schema: "openclaw.capital.energy-contract-subscription-plan.v1",
      candidateCodes,
    },
    priority: {
      displacedCurrentSubscribed: ["VX0000"],
    },
    safety: {
      loginAttemptedByThisScript: false,
      subscriptionAttemptedByThisScript: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
    },
  };
}

function callbackFixture({ paperEligible = 0 } = {}) {
  return {
    schema: "openclaw.capital.energy-callback-verification.v1",
    status: paperEligible > 0 ? "paper_candidates_verified" : "callback_pending",
    readOnly: true,
    loginAttempted: false,
    subscriptionAttemptedByThisScript: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    summary: {
      routeCount: 10,
      callbackVerifiedRouteCount: paperEligible,
      paperStrategyEligibleRouteCount: paperEligible,
    },
  };
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-page-refresh-"));
const rotationReport = path.join(tempRoot, "rotation.json");
const callbackReport = path.join(tempRoot, "callback.json");
await writeJson(rotationReport, rotationFixture());
await writeJson(callbackReport, callbackFixture());

const waiting = await buildCapitalActivePageRefreshPlan({
  rotationReport,
  callbackVerification: callbackReport,
});
assert.equal(waiting.schema, "openclaw.capital.active-page-refresh-plan.v1");
assert.equal(waiting.status, "ready_for_operator_refresh");
assert.equal(waiting.readOnly, true);
assert.equal(waiting.loginAttempted, false);
assert.equal(waiting.subscriptionAttemptedByThisScript, false);
assert.equal(waiting.liveTradingEnabled, false);
assert.equal(waiting.writeTradingEnabled, false);
assert.equal(waiting.sentOrder, false);
assert.equal(waiting.activePage.missingEnergyContractCandidates.length, 0);
assert.equal(waiting.paperStrategyEvaluatorGate.enabled, false);
assert.ok(waiting.controlledRefreshPlan.operatorActionRequired);
assert.ok(
  waiting.controlledRefreshPlan.steps.some(
    (step) =>
      step.id === "operator_refresh_brokerdesk_active_page" &&
      step.autoExecutableByOpenClaw === false,
  ),
);

await writeJson(callbackReport, callbackFixture({ paperEligible: 1 }));
const eligible = await buildCapitalActivePageRefreshPlan({
  rotationReport,
  callbackVerification: callbackReport,
});
assert.equal(eligible.status, "paper_strategy_gate_ready");
assert.equal(eligible.paperStrategyEvaluatorGate.enabled, true);
assert.ok(
  eligible.controlledRefreshPlan.steps.some(
    (step) => step.id === "paper_strategy_evaluator_gate" && step.enabled === true,
  ),
);

await writeJson(rotationReport, rotationFixture({ omitCandidate: "CL2608" }));
const blocked = await buildCapitalActivePageRefreshPlan({
  rotationReport,
  callbackVerification: callbackReport,
});
assert.equal(blocked.status, "blocked");
assert.ok(blocked.blockers.includes("active_page_missing_energy_contract_candidates"));
assert.deepEqual(blocked.activePage.missingEnergyContractCandidates, ["CL2608"]);

console.log(
  JSON.stringify(
    {
      status: "PASS",
      assertions: [
        "activePage refresh plan is read-only and no-login/no-subscribe",
        "operator-controlled activePage refresh is explicit",
        "paper evaluator is blocked until exact callback gate passes",
        "missing energy candidate blocks the refresh plan",
      ],
    },
    null,
    2,
  ),
);
