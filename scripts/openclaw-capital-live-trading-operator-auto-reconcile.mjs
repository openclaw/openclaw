import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingOperatorGate } from "./openclaw-capital-live-trading-operator-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const CAPITAL_ROOT =
  process.env.OPENCLAW_CAPITAL_HFT_SERVICE_ROOT || "D:\\群益及元大API\\CapitalHftService";

const DEFAULT_APPROVAL_PATH = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const DEFAULT_RISK_CONTROLS_PATH = path.join(CAPITAL_ROOT, "risk-controls.json");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-operator-auto-reconcile-latest.json",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const approvalPath = path.resolve(argValue("--approval", DEFAULT_APPROVAL_PATH));
  const riskControlsPath = path.resolve(argValue("--risk-controls", DEFAULT_RISK_CONTROLS_PATH));
  const reportPath = path.resolve(argValue("--report", DEFAULT_REPORT_PATH));
  const execute = hasFlag("--execute");
  const writeState = hasFlag("--write-state");

  const { report } = await runCapitalLiveTradingOperatorGate({
    action: "reconcile",
    execute,
    writeState,
    approvalPath,
    riskControlsPath,
    reportPath,
  });

  const wrapper = {
    schema: "openclaw.capital.live-trading-operator-auto-reconcile.v1",
    generatedAt: new Date().toISOString(),
    execute,
    approvalPath,
    riskControlsPath,
    status: report.status,
    applied: report.applied,
    blockerCode: report.blockerCode || "",
    blockers: Array.isArray(report.blockers) ? report.blockers : [],
    enabledAfter: report?.riskControls?.enabledAfter === true,
    sentOrder: report?.safety?.sentOrder === true,
    activationExpired: report?.riskControls?.activationExpired === true,
    nextSafeTask: report.nextSafeTask || "",
  };

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(wrapper, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading auto-reconcile",
        `status=${wrapper.status}`,
        `applied=${wrapper.applied}`,
        `enabledAfter=${wrapper.enabledAfter}`,
        `activationExpired=${wrapper.activationExpired}`,
        `blockerCode=${wrapper.blockerCode || "none"}`,
        `sentOrder=${wrapper.sentOrder}`,
        `nextSafeTask=${wrapper.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
