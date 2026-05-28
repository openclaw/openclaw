#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalExternalBrokerAdapterAckGate } from "./openclaw-capital-external-broker-adapter-ack-gate.mjs";

const SCHEMA = "openclaw.capital.adapter-ack-hash-handoff-verifier.v1";
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

function handoffItem(order, id, status, action, validationCommand = "") {
  return { order, id, status, action, validationCommand };
}

function pnpmCommand(repoRoot, scriptName) {
  return `pnpm --dir ${path.resolve(repoRoot)} ${scriptName}`;
}

function isRepoRootPnpmCommand(command) {
  return /^pnpm --dir .+ /u.test(safeString(command));
}

function isConcreteIsoTimestamp(value) {
  const text = safeString(value);
  return text.length > 0 && text !== "ISO-8601" && Number.isFinite(Date.parse(text));
}

function renderMarkdown(report) {
  return [
    "# Capital Adapter Ack Hash Handoff Verifier",
    "",
    `status: ${report.status}`,
    `sealedIntentSha256: ${report.sealedIntentSha256 || "missing"}`,
    `hashOk: ${report.hash.hashOk}`,
    `expected: ${report.hash.expectedSealedIntentSha256 || "missing"}`,
    `actual: ${report.hash.actualSealedIntentSha256 || "missing"}`,
    `candidate: ${report.hash.candidateSealedIntentSha256 || "missing"}`,
    `candidateRollbackVerifiedAt: ${
      report.operatorHandoff.candidateRollbackVerifiedAt || "missing"
    }`,
    `safeToPromoteCandidate: ${report.operatorHandoff.safeToPromoteCandidate}`,
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

export function buildCapitalAdapterAckHashHandoffVerifierReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const adapterAckGate = options.adapterAckGate ?? {};
  const ack = adapterAckGate.ack ?? {};
  const operatorReview = adapterAckGate.operatorReview ?? {};
  const refreshPlan = operatorReview.refreshPlan ?? {};
  const candidateAck = operatorReview.candidateAck ?? ack.expectedValue ?? {};
  const expectedSealedIntentSha256 = safeString(
    ack.sealedIntentHash?.expected ||
      operatorReview.expectedSealedIntentSha256 ||
      ack.expectedValue?.sealedIntentSha256 ||
      adapterAckGate.sealedIntentSha256,
  );
  const actualSealedIntentSha256 = safeString(
    ack.sealedIntentHash?.actual ||
      operatorReview.actualSealedIntentSha256 ||
      ack.currentValue?.sealedIntentSha256,
  );
  const candidateSealedIntentSha256 = safeString(
    candidateAck.sealedIntentSha256 ||
      refreshPlan.candidateSealedIntentSha256 ||
      ack.expectedValue?.sealedIntentSha256,
  );
  const activeAckPath = safeString(operatorReview.activeAckPath || ack.activePath);
  const stagedCandidateAckPath = safeString(
    operatorReview.stagedCandidateAckPath || adapterAckGate.paths?.stagedCandidateAckPath,
  );
  const requiredTemplatePath = safeString(
    operatorReview.requiredTemplatePath ||
      ack.requiredTemplatePath ||
      ack.sealedIntentHash?.requiredTemplatePath ||
      adapterAckGate.paths?.requiredTemplatePath,
  );
  const candidateRollbackVerifiedAt = safeString(
    refreshPlan.candidateRollbackVerifiedAt ||
      ack.rollbackVerifiedAt ||
      candidateAck.rollback?.verifiedAt,
  );
  const hashOk =
    ack.hashOk === true ||
    (expectedSealedIntentSha256.length > 0 &&
      actualSealedIntentSha256 === expectedSealedIntentSha256);
  const activeHashMismatchDetected =
    hashOk ||
    (expectedSealedIntentSha256.length > 0 &&
      actualSealedIntentSha256.length > 0 &&
      expectedSealedIntentSha256 !== actualSealedIntentSha256);
  const candidateMatchesSealedIntent =
    expectedSealedIntentSha256.length > 0 &&
    candidateSealedIntentSha256 === expectedSealedIntentSha256;
  const canaryPass =
    ack.canaryPass === true ||
    (candidateAck.canary?.status === "pass" && candidateAck.canary?.dryRun === true);
  const canarySentOrder = ack.canarySentOrder === true || candidateAck.canary?.sentOrder === true;
  const rollbackFresh = ack.rollbackFresh === true || refreshPlan.rollbackFresh === true;
  const safeToPromoteCandidate =
    hashOk || refreshPlan.safeToPromoteCandidate === true || adapterAckGate.status === "verified";
  const activeAckWriteSuppressed =
    operatorReview.activeAckWriteSuppressed === true ||
    refreshPlan.activeAckWriteSuppressed === true ||
    adapterAckGate.safety?.wroteActiveAdapterAck === false;
  const conversationAgentsMayWriteActiveAck =
    operatorReview.conversationAgentsMayWriteActiveAck === true ||
    refreshPlan.conversationAgentsMayWriteActiveAck === true;
  const allowedWriter = safeString(operatorReview.allowedWriter || refreshPlan.allowedWriter);
  const noLiveOrderSent =
    adapterAckGate.safety?.sentOrder !== true &&
    adapterAckGate.safety?.brokerWriteAttempted !== true &&
    adapterAckGate.safety?.noLiveOrderSent !== false;
  const validationCommands = {
    adapterAck: pnpmCommand(repoRoot, "capital:trade:adapter-ack:check"),
    liveReadiness: pnpmCommand(repoRoot, "capital:live-readiness:check"),
    operatorPacket: pnpmCommand(repoRoot, "capital:trade:operator-packet:check"),
  };
  const commandsRepoRootQualified = Object.values(validationCommands).every(isRepoRootPnpmCommand);
  const concreteRollback = isConcreteIsoTimestamp(candidateRollbackVerifiedAt);
  const checks = [
    check("sealed-intent:present", expectedSealedIntentSha256.length > 0, {
      expectedSealedIntentSha256,
    }),
    check("active-ack:path-present", activeAckPath.length > 0, { activeAckPath }),
    check("staged-candidate:path-present", stagedCandidateAckPath.length > 0, {
      stagedCandidateAckPath,
    }),
    check("hash:active-mismatch-detected", activeHashMismatchDetected, {
      hashOk,
      expectedSealedIntentSha256,
      actualSealedIntentSha256,
    }),
    check("hash:candidate-matches-sealed-intent", candidateMatchesSealedIntent, {
      candidateSealedIntentSha256,
      expectedSealedIntentSha256,
    }),
    check("rollback:candidate-concrete", concreteRollback, {
      candidateRollbackVerifiedAt,
    }),
    check("canary:no-order", canaryPass && !canarySentOrder, {
      canaryPass,
      canarySentOrder,
    }),
    check("rollback:fresh", rollbackFresh, { rollbackFresh }),
    check("promotion:safe-to-promote-candidate", safeToPromoteCandidate, {
      safeToPromoteCandidate,
    }),
    check("safety:active-ack-write-suppressed", activeAckWriteSuppressed, {
      activeAckWriteSuppressed,
      wroteActiveAdapterAck: adapterAckGate.safety?.wroteActiveAdapterAck === true,
    }),
    check("safety:no-live-order-sent", noLiveOrderSent, { noLiveOrderSent }),
    check("commands:repo-root-qualified", commandsRepoRootQualified, validationCommands),
  ];
  const failed = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const readyForOperatorHandoff =
    !hashOk &&
    failed.length === 0 &&
    activeAckPath !== stagedCandidateAckPath &&
    !conversationAgentsMayWriteActiveAck &&
    allowedWriter === "operator-owned-broker-adapter-only";
  const verifiedNoHandoffRequired = hashOk && failed.length === 0;
  const status = readyForOperatorHandoff
    ? "ready_for_operator_handoff"
    : verifiedNoHandoffRequired
      ? "verified_no_handoff_required"
      : "blocked";
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-hash-handoff-verifier-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-hash-handoff-verifier-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-adapter-ack-hash-handoff-verifier.json");
  const handoffChecklist = [
    handoffItem(
      1,
      "review_staged_candidate_ack",
      candidateMatchesSealedIntent ? "ready" : "blocked",
      "Review staged candidate ack and confirm it matches the current sealed order intent.",
      validationCommands.adapterAck,
    ),
    handoffItem(
      2,
      "compare_active_and_candidate_hash",
      activeHashMismatchDetected ? "ready" : "blocked",
      "Compare active ack sealedIntentSha256 against the staged candidate before refresh.",
      validationCommands.adapterAck,
    ),
    handoffItem(
      3,
      "verify_canary_no_order",
      canaryPass && !canarySentOrder ? "ready" : "blocked",
      "Confirm canary evidence is dry-run only and sentOrder remains false.",
      validationCommands.adapterAck,
    ),
    handoffItem(
      4,
      "verify_rollback_freshness",
      rollbackFresh && concreteRollback ? "ready" : "blocked",
      "Confirm rollback verification is fresh and concrete, not a placeholder.",
      validationCommands.adapterAck,
    ),
    handoffItem(
      5,
      "operator_owned_active_ack_refresh",
      readyForOperatorHandoff
        ? "pending_operator_owned_adapter"
        : verifiedNoHandoffRequired
          ? "complete"
          : "blocked",
      "Only the operator-owned broker adapter may promote the staged candidate into the active ack path.",
      validationCommands.adapterAck,
    ),
    handoffItem(
      6,
      "rerun_adapter_ack",
      verifiedNoHandoffRequired ? "complete" : "pending_after_operator_refresh",
      "Rerun adapter ack verification after the operator-owned refresh.",
      validationCommands.adapterAck,
    ),
    handoffItem(
      7,
      "rerun_live_readiness",
      verifiedNoHandoffRequired ? "ready" : "pending_after_ack_verified",
      "Rerun live readiness aggregation only after adapter ack is verified.",
      validationCommands.liveReadiness,
    ),
  ];
  const nextSafeTask = readyForOperatorHandoff
    ? `operator-owned adapter refreshes active ack from ${stagedCandidateAckPath}; then rerun ${validationCommands.adapterAck}.`
    : verifiedNoHandoffRequired
      ? `adapter ack hash already matches; rerun ${validationCommands.liveReadiness}.`
      : "Fix failed handoff verifier checks before operator-owned ack refresh.";
  const machineLine = [
    `capitalAdapterAckHandoff=${status}`,
    `sha256=${expectedSealedIntentSha256 || "missing"}`,
    `hashOk=${hashOk}`,
    `candidateMatches=${candidateMatchesSealedIntent}`,
    `rollbackConcrete=${concreteRollback}`,
    `safeToPromoteCandidate=${safeToPromoteCandidate}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${failed.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "report_only_operator_ack_hash_handoff",
    sealedIntentSha256: expectedSealedIntentSha256,
    machineLine,
    hash: {
      hashOk,
      expectedSealedIntentSha256,
      actualSealedIntentSha256,
      candidateSealedIntentSha256,
      activeHashMismatchDetected,
      candidateMatchesSealedIntent,
      activeAckPath,
      stagedCandidateAckPath,
      requiredTemplatePath,
    },
    operatorHandoff: {
      status: readyForOperatorHandoff
        ? "ready_for_operator_owned_ack_refresh"
        : verifiedNoHandoffRequired
          ? "not_required"
          : "blocked",
      sourcePath: stagedCandidateAckPath,
      destinationPath: activeAckPath,
      requiredTemplatePath,
      candidateRollbackVerifiedAt,
      canaryPass,
      canarySentOrder,
      rollbackFresh,
      safeToPromoteCandidate,
      activeAckWriteSuppressed,
      conversationAgentsMayWriteActiveAck,
      allowedWriter,
      instruction:
        "Report-only verifier: conversation agents must not write active ack; only the operator-owned broker adapter may refresh it after canary and rollback checks.",
      handoffChecklist,
      validationCommands,
    },
    checks,
    blockers: failed,
    safety: {
      generatedReportOnly: true,
      wroteActiveAdapterAck: false,
      activeAckWriteSuppressed,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      conversationAgentDirectBrokerWrite: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
      adapterAckGateReportPath: adapterAckGate.paths?.reportPath || "",
      activeAckPath,
      stagedCandidateAckPath,
      requiredTemplatePath,
    },
    nextSafeTask,
  };
}

export async function buildCapitalAdapterAckHashHandoffVerifier(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const adapterAckGate =
    options.adapterAckGate ?? (await buildCapitalExternalBrokerAdapterAckGate({ repoRoot }));
  return buildCapitalAdapterAckHashHandoffVerifierReport({
    repoRoot,
    generatedAt: options.generatedAt,
    adapterAckGate,
  });
}

async function main() {
  const report = await buildCapitalAdapterAckHashHandoffVerifier({ repoRoot: process.cwd() });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }

  if (
    hasFlag("--check") &&
    (report.safety.sentOrder ||
      report.safety.brokerWriteAttempted ||
      report.safety.wroteActiveAdapterAck)
  ) {
    throw new Error("CAPITAL_ADAPTER_ACK_HASH_HANDOFF_VERIFIER_UNSAFE_WRITE");
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
      `capital adapter ack hash handoff verifier failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
