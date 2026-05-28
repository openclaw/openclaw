#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const WORKFLOW_SCHEMA = "openclaw.resolution-workflow.v1";
const WORKFLOW_REPORT_REL = "reports/openclaw-resolution-workflow-latest.json";
const WORKFLOW_CHECKLIST_REL = "reports/openclaw-resolution-workflow-checklist.md";

const REQUIRED_STAGE_IDS = [
  "source-intake",
  "weak-signal-intake-gate",
  "resolver-candidates",
  "runner-routing",
  "evidence-lock",
  "promotion-gate",
];

const REQUIRED_PACKAGE_SCRIPTS = {
  "autonomous:resolution-workflow": "scripts/openclaw-resolution-workflow.mjs",
  "autonomous:resolution-workflow:check": "scripts/check-openclaw-resolution-workflow.mjs",
  "check:openclaw-resolution-workflow": "scripts/check-openclaw-resolution-workflow.mjs",
};

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

function assertPackageScripts(packageJson) {
  for (const [scriptName, token] of Object.entries(REQUIRED_PACKAGE_SCRIPTS)) {
    const value = packageJson.scripts?.[scriptName];
    assertCondition(
      typeof value === "string" && value.includes(token),
      `package script ${scriptName} must include ${token}`,
    );
  }
}

async function main() {
  const repoRoot = process.cwd();
  const report = await readJson(path.join(repoRoot, WORKFLOW_REPORT_REL));
  const packageJson = await readJson(path.join(repoRoot, "package.json"));
  const checklist = await fs.readFile(path.join(repoRoot, WORKFLOW_CHECKLIST_REL), "utf8");
  const stages = Array.isArray(report.stages) ? report.stages : [];
  const stageIds = new Set(stages.map((stage) => stage.id));

  assertPackageScripts(packageJson);
  assertCondition(report.schema === WORKFLOW_SCHEMA, "schema mismatch");
  assertCondition(report.mode === "integrated_resolution_workflow", "mode mismatch");
  assertCondition(report.status === "ready_with_promotion_blocked", "workflow status mismatch");
  assertCondition(report.safety?.dryRunOnly === true, "dryRunOnly must be true");
  assertCondition(
    report.safety?.runtimeMutationAllowed === false,
    "runtime mutation must be false",
  );
  assertCondition(report.safety?.externalWriteAllowed === false, "external write must be false");
  assertCondition(report.safety?.autoExecuteAllowed === false, "auto execute must be false");
  assertCondition(report.safety?.liveTradingAllowed === false, "live trading must be false");
  for (const requiredId of REQUIRED_STAGE_IDS) {
    assertCondition(stageIds.has(requiredId), `missing workflow stage ${requiredId}`);
  }
  for (const stage of stages) {
    assertCondition(stage.status === "pass", `stage must pass: ${stage.id}`);
    assertCondition(
      typeof stage.command === "string" && stage.command.length > 0,
      `stage command missing: ${stage.id}`,
    );
    assertCondition(
      typeof stage.evidence === "string" && stage.evidence.length > 0,
      `stage evidence missing: ${stage.id}`,
    );
  }
  assertCondition(report.summary?.failedStages === 0, "workflow must have zero failed stages");
  assertCondition(report.summary?.promotionAllowed === false, "promotion must not be allowed");
  assertCondition(
    report.promotionGate?.status === "blocked_p0_p1_open",
    "promotion gate must be blocked by P0/P1",
  );
  assertCondition(
    Array.isArray(report.promotionGate?.openP0P1Candidates) &&
      report.promotionGate.openP0P1Candidates.length > 0,
    "open P0/P1 candidates must be recorded",
  );
  assertCondition(
    report.sourceReports?.weakSignalIntakeGate ===
      "reports/openclaw-weak-signal-intake-gate-latest.json",
    "weak-signal report path mismatch",
  );
  assertCondition(report.nextSafeTask?.id === "cron-watch-source-check", "next safe task mismatch");
  assertCondition(checklist.includes("完整正確工作流程"), "checklist must describe workflow");
  assertCondition(
    checklist.includes("needs-confirmation"),
    "checklist must preserve weak-signal gate",
  );

  process.stdout.write("OPENCLAW_RESOLUTION_WORKFLOW_CHECK=OK\n");
}

main().catch((error) => {
  process.stderr.write(
    `OPENCLAW_RESOLUTION_WORKFLOW_CHECK=FAIL ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
