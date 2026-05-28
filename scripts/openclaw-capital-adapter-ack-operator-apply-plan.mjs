#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalAdapterAckOperatorApplyVerifier } from "./openclaw-capital-adapter-ack-operator-apply-verifier.mjs";

const SCHEMA = "openclaw.capital.adapter-ack-operator-apply-plan.v1";
const currentFile = fileURLToPath(import.meta.url);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function passFail(ok) {
  return ok ? "pass" : "fail";
}

function check(id, ok, evidence = {}) {
  return { id, status: passFail(ok), evidence };
}

function pnpmCommand(repoRoot, scriptName) {
  return `pnpm --dir ${path.resolve(repoRoot)} ${scriptName}`;
}

function isRepoRootPnpmCommand(command) {
  return /^pnpm --dir .+ /u.test(safeString(command));
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function renderMarkdown(report) {
  return [
    "# Capital Adapter Ack Operator Apply Plan",
    "",
    `status: ${report.status}`,
    `sealedIntentSha256: ${report.sealedIntentSha256 || "missing"}`,
    `planStatus: ${report.operatorApplyPlan.status}`,
    `sourcePath: ${report.operatorApplyPlan.sourcePath || "missing"}`,
    `destinationPath: ${report.operatorApplyPlan.destinationPath || "missing"}`,
    `backupPath: ${report.operatorApplyPlan.backupPath || "missing"}`,
    `tempPath: ${report.operatorApplyPlan.tempPath || "missing"}`,
    `noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `machineLine: ${report.machineLine}`,
    "",
    "## Checks",
    ...report.checks.map((item) => `- ${item.id}: ${item.status}`),
    "",
    "## Blockers",
    ...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

export async function buildCapitalAdapterAckOperatorApplyPlan(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const stagingRoot = path.join(tradingRoot, "staging");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const verifier =
    options.verifier ??
    (await buildCapitalAdapterAckOperatorApplyVerifier({ repoRoot, generatedAt }));
  const verdict = verifier.applyVerdict ?? {};
  const sourcePath = safeString(verdict.sourcePath);
  const destinationPath = safeString(verdict.destinationPath);
  const backupPath = safeString(verdict.backupPath);
  const candidateContentSha256 = safeString(verdict.candidateContentSha256);
  const currentContentSha256 = safeString(verdict.currentContentSha256);
  const destinationDir = destinationPath ? path.dirname(destinationPath) : tradingRoot;
  const tempPath = path.join(
    destinationDir,
    `.capital-external-broker-adapter-ack.${candidateContentSha256 || "candidate"}.tmp`,
  );
  const validationCommands = {
    applyPlan: pnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-plan:check"),
    applyVerifier: pnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-verifier:check"),
    adapterAck: pnpmCommand(repoRoot, "capital:trade:adapter-ack:check"),
    liveReadiness: pnpmCommand(repoRoot, "capital:live-readiness:check"),
  };
  const validationCommandsQualified =
    Object.values(validationCommands).every(isRepoRootPnpmCommand);
  const verifierReady = verifier.status === "ready_for_operator_apply";
  const alreadyApplied = verifier.status === "applied_verified";
  const noApplyRequired = verifier.status === "no_apply_required";
  const pathsDistinct =
    sourcePath.length > 0 &&
    destinationPath.length > 0 &&
    backupPath.length > 0 &&
    tempPath.length > 0 &&
    sourcePath !== destinationPath &&
    sourcePath !== backupPath &&
    destinationPath !== backupPath &&
    destinationPath !== tempPath &&
    backupPath !== tempPath;
  const backupPathValid =
    backupPath.length > 0 &&
    isInside(stagingRoot, backupPath) &&
    currentContentSha256.length > 0 &&
    backupPath.includes(currentContentSha256);
  const tempPathValid =
    tempPath.length > 0 &&
    path.dirname(path.resolve(tempPath)) === path.dirname(path.resolve(destinationPath)) &&
    candidateContentSha256.length > 0 &&
    tempPath.includes(candidateContentSha256);
  const preApplyKnown =
    verdict.activeState === "pre_apply_current_matches" &&
    verdict.destinationContentSha256 === currentContentSha256 &&
    verdict.operatorMayApply === true;
  const appliedKnown =
    verdict.activeState === "applied_candidate_matches" &&
    verdict.destinationContentSha256 === candidateContentSha256 &&
    verdict.operatorApplyVerified === true;
  const noApplyKnown =
    verdict.activeState === "pre_apply_current_matches" &&
    verdict.destinationContentSha256 === currentContentSha256 &&
    verdict.operatorMayApply === false &&
    verdict.operatorApplyVerified === false;
  const checks = [
    check("verifier:ready-or-applied", verifierReady || alreadyApplied || noApplyRequired, {
      status: verifier.status,
    }),
    check("verdict:known-active-state", preApplyKnown || appliedKnown || noApplyKnown, {
      activeState: verdict.activeState,
      operatorMayApply: verdict.operatorMayApply === true,
      operatorApplyVerified: verdict.operatorApplyVerified === true,
    }),
    check("paths:source-destination-backup-temp-distinct", pathsDistinct, {
      sourcePath,
      destinationPath,
      backupPath,
      tempPath,
    }),
    check("backup:path-under-staging-and-hash-named", backupPathValid, {
      backupPath,
      stagingRoot,
      currentContentSha256,
    }),
    check("temp:path-next-to-destination-and-hash-named", tempPathValid, {
      tempPath,
      destinationPath,
      candidateContentSha256,
    }),
    check("commands:repo-root-qualified", validationCommandsQualified, validationCommands),
    check("safety:dry-run-plan-only", true, {
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
    }),
    check("safety:no-live-order-sent", verifier.safety?.noLiveOrderSent === true, {
      noLiveOrderSent: verifier.safety?.noLiveOrderSent === true,
    }),
  ];
  const blockers = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const status =
    blockers.length === 0 && alreadyApplied
      ? "already_applied_verified"
      : blockers.length === 0 && noApplyRequired
        ? "no_apply_required"
        : blockers.length === 0
          ? "ready_atomic_apply_plan"
          : "blocked";
  const planPath = path.join(
    stagingRoot,
    "capital-external-broker-adapter-ack-operator-apply-plan.json",
  );
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-operator-apply-plan-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-operator-apply-plan-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-adapter-ack-operator-apply-plan.json");
  const operatorApplyPlan = {
    schema: "openclaw.capital.external-broker-adapter-ack-operator-apply-plan.v1",
    status,
    generatedAt,
    owner: "operator-owned-broker-adapter-only",
    dryRunOnly: true,
    applyAllowedByPlan: status === "ready_atomic_apply_plan",
    alreadyAppliedVerified: status === "already_applied_verified",
    noApplyRequired: status === "no_apply_required",
    packetPath: safeString(verdict.packetPath),
    sourcePath,
    destinationPath,
    backupPath,
    tempPath,
    sealedIntentSha256: safeString(verdict.sealedIntentSha256),
    currentContentSha256,
    candidateContentSha256,
    preconditions: [
      "destination_content_sha256_must_equal_currentContentSha256",
      "source_content_sha256_must_equal_candidateContentSha256",
      "backup_path_must_not_exist_or_must_match_currentContentSha256_when_operator_adapter_checks_it",
      "operator_adapter_must_write_backup_before_replace",
      "operator_adapter_must_atomic_replace_destination_from_temp",
    ],
    orderedDryRunOperations: [
      {
        order: 1,
        id: "verify_destination_current_hash",
        operation: "read_only_hash_check",
        path: destinationPath,
        expectedSha256: currentContentSha256,
      },
      {
        order: 2,
        id: "verify_source_candidate_hash",
        operation: "read_only_hash_check",
        path: sourcePath,
        expectedSha256: candidateContentSha256,
      },
      {
        order: 3,
        id: "plan_backup_active_ack",
        operation: "operator_adapter_copy_only_after_hash_check",
        sourcePath: destinationPath,
        destinationPath: backupPath,
      },
      {
        order: 4,
        id: "plan_write_temp_candidate",
        operation: "operator_adapter_write_temp_only",
        sourcePath,
        destinationPath: tempPath,
      },
      {
        order: 5,
        id: "plan_atomic_replace_active_ack",
        operation: "operator_adapter_atomic_replace_only",
        sourcePath: tempPath,
        destinationPath,
      },
      {
        order: 6,
        id: "post_apply_verify_adapter_ack",
        operation: "run_validation",
        command: validationCommands.adapterAck,
      },
      {
        order: 7,
        id: "post_apply_verify_live_readiness",
        operation: "run_validation",
        command: validationCommands.liveReadiness,
      },
    ],
    validationCommands,
    safety: {
      generatedPlanOnly: true,
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
  };
  const machineLine = [
    `capitalAdapterAckApplyPlan=${status}`,
    `sha256=${operatorApplyPlan.sealedIntentSha256 || "missing"}`,
    `applyAllowedByPlan=${operatorApplyPlan.applyAllowedByPlan}`,
    `alreadyAppliedVerified=${operatorApplyPlan.alreadyAppliedVerified}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "operator_adapter_atomic_apply_plan_report_only",
    sealedIntentSha256: operatorApplyPlan.sealedIntentSha256,
    machineLine,
    operatorApplyPlan,
    checks,
    blockers,
    safety: {
      generatedPlanOnly: true,
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      planPath,
      reportPath,
      markdownPath,
      panelPath,
      applyVerifierReportPath: verifier.paths?.reportPath || "",
      sourcePath,
      destinationPath,
      backupPath,
      tempPath,
    },
    nextSafeTask:
      status === "ready_atomic_apply_plan"
        ? `operator-owned adapter may dry-run and then apply ${planPath}; rerun ${validationCommands.applyVerifier}.`
        : status === "already_applied_verified"
          ? `Adapter apply is verified; rerun ${validationCommands.adapterAck} and ${validationCommands.liveReadiness}.`
          : status === "no_apply_required"
            ? `Active ack already matches sealed intent; skip apply plan and rerun ${validationCommands.liveReadiness}.`
            : "Fix apply plan blockers before operator-owned adapter apply.",
  };
}

async function main() {
  const report = await buildCapitalAdapterAckOperatorApplyPlan({ repoRoot: process.cwd() });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.planPath, report.operatorApplyPlan);
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }

  if (
    hasFlag("--check") &&
    (report.safety.sentOrder === true ||
      report.safety.brokerWriteAttempted === true ||
      report.safety.wroteActiveAdapterAck === true ||
      report.safety.wroteBackup === true ||
      report.safety.wroteTemp === true)
  ) {
    throw new Error("CAPITAL_ADAPTER_ACK_OPERATOR_APPLY_PLAN_UNSAFE_WRITE");
  }

  if (hasFlag("--json") || hasFlag("--check")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${report.machineLine}\nnextSafeTask=${report.nextSafeTask}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital adapter ack operator apply plan failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
