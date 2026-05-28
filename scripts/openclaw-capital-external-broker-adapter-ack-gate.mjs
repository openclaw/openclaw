#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalLiveOrderDryRunPretradeGate } from "./openclaw-capital-live-order-dry-run-pretrade-gate.mjs";

const SCHEMA = "openclaw.capital.external-broker-adapter-ack-gate.v1";
const ACK_ROLLBACK_MAX_FRESH_SECONDS = 12 * 60 * 60;
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

function passFail(ok) {
  return ok ? "pass" : "fail";
}

function check(id, ok, evidence = {}) {
  return { id, status: passFail(ok), evidence };
}

function handoffItem(order, id, status, action, validationCommand = "") {
  return { order, id, status, action, validationCommand };
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pnpmCommand(repoRoot, scriptName) {
  return `pnpm --dir ${path.resolve(repoRoot)} ${scriptName}`;
}

function timestampAgeSeconds(value, nowMs) {
  const parsed = Date.parse(safeString(value));
  if (!Number.isFinite(parsed) || !Number.isFinite(nowMs)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function renderMarkdown(report) {
  return [
    "# Capital External Broker Adapter Ack Gate",
    "",
    `status: ${report.status}`,
    `sealedIntentSha256: ${report.sealedIntentSha256}`,
    `ackStatus: ${report.ack.status}`,
    `ackUsable: ${report.ack.usable}`,
    `activePath: ${report.ack.activePath}`,
    `templatePath: ${report.ack.requiredTemplatePath}`,
    `stagedCandidateAckPath: ${report.operatorReview.stagedCandidateAckPath}`,
    `hashExpected: ${report.ack.sealedIntentHash.expected}`,
    `hashActual: ${report.ack.sealedIntentHash.actual || "missing"}`,
    `hashAction: ${report.ack.sealedIntentHash.operatorAction}`,
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

export function buildCapitalExternalBrokerAdapterAckReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const templateRoot = path.join(tradingRoot, "templates");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const gate = options.gate ?? {};
  const ack = gate.operatorHandoff?.externalBrokerAdapter?.ack ?? {};
  const sealedOrderIntent = gate.operatorHandoff?.handoffPacket?.sealedOrderIntent ?? {};
  const sealedIntentSha256 = safeString(
    sealedOrderIntent.sha256 || ack.requiredSealedIntentSha256 || "",
  );
  const currentAck = options.currentAck ?? {};
  const rollbackVerifiedAt = safeString(currentAck.rollback?.verifiedAt);
  const expectedAck = {
    schema: "openclaw.capital.external-broker-adapter-ack.v1",
    adapterId: safeString(ack.adapterId) || "operator-capital-live-adapter",
    owner: "operator",
    sealedIntentSha256,
    canary: {
      status: "pass",
      dryRun: true,
      sentOrder: false,
    },
    rollback: {
      status: "pass",
      verifiedAt: rollbackVerifiedAt,
    },
  };
  const schemaOk = ack.schemaOk === true || currentAck.schema === expectedAck.schema;
  const ownerOk = ack.ownerOk === true || currentAck.owner === "operator";
  const hashOk =
    ack.hashOk === true ||
    (sealedIntentSha256.length > 0 && currentAck.sealedIntentSha256 === sealedIntentSha256);
  const canaryPass =
    ack.canaryPass === true ||
    (currentAck.canary?.status === "pass" &&
      currentAck.canary?.dryRun === true &&
      currentAck.canary?.sentOrder === false);
  const canaryDryRun = currentAck.canary?.dryRun === true;
  const canarySentOrder = currentAck.canary?.sentOrder === true;
  const rollbackPass =
    ack.rollbackPass === true ||
    (currentAck.rollback?.status === "pass" &&
      safeString(currentAck.rollback?.verifiedAt).length > 0);
  const rollbackAgeSeconds = timestampAgeSeconds(rollbackVerifiedAt, nowMs);
  const rollbackFresh =
    rollbackPass &&
    rollbackAgeSeconds !== null &&
    rollbackAgeSeconds <= ACK_ROLLBACK_MAX_FRESH_SECONDS;
  const activeExists = ack.exists === true || Object.keys(currentAck).length > 0;
  const noLiveOrderSent =
    gate.safety?.sentOrder !== true &&
    currentAck.canary?.sentOrder !== true &&
    currentAck.sentOrder !== true;
  const checks = [
    check("sealed-intent:present", sealedIntentSha256.length > 0, { sealedIntentSha256 }),
    check("ack:active-file-exists", activeExists, { path: ack.path || "" }),
    check("ack:schema", schemaOk, {
      expected: expectedAck.schema,
      actual: currentAck.schema || "",
    }),
    check("ack:owner", ownerOk, { expected: "operator", actual: currentAck.owner || "" }),
    check("ack:sealed-intent-hash-match", hashOk, {
      expected: sealedIntentSha256,
      actual: currentAck.sealedIntentSha256 || "",
    }),
    check("ack:canary-dry-run-pass", canaryPass, {
      canary: currentAck.canary || null,
    }),
    check("ack:rollback-pass", rollbackPass, {
      rollback: currentAck.rollback || null,
    }),
    check("ack:rollback-freshness", rollbackFresh, {
      verifiedAt: rollbackVerifiedAt,
      ageSeconds: rollbackAgeSeconds,
      maxFreshSeconds: ACK_ROLLBACK_MAX_FRESH_SECONDS,
    }),
    check("safety:no-live-order-sent", noLiveOrderSent, {
      gateSentOrder: gate.safety?.sentOrder === true,
      ackCanarySentOrder: currentAck.canary?.sentOrder === true,
      ackSentOrder: currentAck.sentOrder === true,
    }),
    check("safety:active-ack-not-written-by-this-gate", true, {
      wroteActiveAdapterAck: false,
    }),
  ];
  const failed = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const status = failed.length === 0 ? "verified" : "blocked";
  const requiredTemplatePath = path.join(
    templateRoot,
    "capital-external-broker-adapter-ack.required-current.json",
  );
  const stagedCandidateAckPath = path.join(
    tradingRoot,
    "staging",
    "capital-external-broker-adapter-ack.staged-current.json",
  );
  const adapterAckCheckCommand = pnpmCommand(repoRoot, "capital:trade:adapter-ack:check");
  const liveReadinessCheckCommand = pnpmCommand(repoRoot, "capital:live-readiness:check");
  const actualSealedIntentSha256 = safeString(currentAck.sealedIntentSha256);
  const sealedIntentHash = {
    expected: sealedIntentSha256,
    actual: actualSealedIntentSha256,
    matched: hashOk,
    mismatch: !hashOk,
    activePath: safeString(ack.path),
    requiredTemplatePath,
    operatorAction: hashOk
      ? "none_required"
      : "operator-owned adapter must refresh active ack from required-current template after canary and rollback verification",
  };
  const activeVsCandidate = {
    status: hashOk ? "matching" : "mismatch",
    activeAckPath: safeString(ack.path),
    stagedCandidateAckPath,
    fields: [
      {
        field: "sealedIntentSha256",
        active: actualSealedIntentSha256,
        candidate: sealedIntentSha256,
        matched: hashOk,
      },
      {
        field: "canary.status",
        active: safeString(currentAck.canary?.status),
        candidate: expectedAck.canary.status,
        matched: currentAck.canary?.status === expectedAck.canary.status,
      },
      {
        field: "canary.dryRun",
        active: currentAck.canary?.dryRun ?? null,
        candidate: expectedAck.canary.dryRun,
        matched: currentAck.canary?.dryRun === expectedAck.canary.dryRun,
      },
      {
        field: "canary.sentOrder",
        active: currentAck.canary?.sentOrder ?? null,
        candidate: expectedAck.canary.sentOrder,
        matched: currentAck.canary?.sentOrder === expectedAck.canary.sentOrder,
      },
      {
        field: "rollback.status",
        active: safeString(currentAck.rollback?.status),
        candidate: expectedAck.rollback.status,
        matched: currentAck.rollback?.status === expectedAck.rollback.status,
      },
      {
        field: "rollback.verifiedAt",
        active: rollbackVerifiedAt,
        candidate: expectedAck.rollback.verifiedAt,
        matched:
          rollbackVerifiedAt.length > 0 && rollbackVerifiedAt === expectedAck.rollback.verifiedAt,
      },
    ],
  };
  const operatorRefreshRequired = !hashOk || !rollbackFresh;
  const candidatePromotionReady =
    operatorRefreshRequired &&
    sealedIntentSha256.length > 0 &&
    canaryPass &&
    !canarySentOrder &&
    rollbackPass &&
    rollbackFresh &&
    expectedAck.rollback.verifiedAt.length > 0;
  const refreshReason = !hashOk
    ? "active_ack_hash_mismatch"
    : !rollbackFresh
      ? "rollback_freshness_stale"
      : "active_ack_matches_current_sealed_intent";
  const refreshPlan = {
    status: operatorRefreshRequired ? "operator_refresh_required" : "not_required",
    reason: refreshReason,
    sourcePath: stagedCandidateAckPath,
    destinationPath: safeString(ack.path),
    requiredTemplatePath,
    expectedSealedIntentSha256: sealedIntentSha256,
    actualSealedIntentSha256,
    candidateSealedIntentSha256: sealedIntentSha256,
    candidateRollbackVerifiedAt: expectedAck.rollback.verifiedAt,
    canaryPass,
    canarySentOrder,
    rollbackPass,
    rollbackFresh,
    safeToPromoteCandidate: candidatePromotionReady,
    activeAckWriteSuppressed: true,
    conversationAgentsMayWriteActiveAck: false,
    allowedWriter: "operator-owned-broker-adapter-only",
    validationCommand: adapterAckCheckCommand,
    postRefreshValidationCommand: liveReadinessCheckCommand,
    operatorAction: operatorRefreshRequired
      ? "operator-owned broker adapter refreshes active ack with concrete fresh rollback verifiedAt, then reruns adapter ack and live readiness checks"
      : "none_required",
  };
  const handoffChecklist = [
    handoffItem(
      1,
      "review_staged_candidate_ack",
      hashOk ? "complete" : "pending",
      "Review staged candidate ack and confirm it matches the current sealed order intent.",
      adapterAckCheckCommand,
    ),
    handoffItem(
      2,
      "verify_canary_dry_run",
      canaryPass && !canarySentOrder ? "complete" : "blocked",
      "Confirm adapter canary is dry-run only and sentOrder remains false.",
      adapterAckCheckCommand,
    ),
    handoffItem(
      3,
      "verify_rollback_freshness",
      rollbackFresh ? "complete" : "blocked",
      "Confirm rollback verification is fresh before any operator-owned ack refresh.",
      adapterAckCheckCommand,
    ),
    handoffItem(
      4,
      "operator_owned_active_ack_refresh",
      operatorRefreshRequired ? "pending_operator_owned_adapter" : "complete",
      "Only the operator-owned broker adapter may copy the reviewed staged candidate into the active ack path.",
      adapterAckCheckCommand,
    ),
    handoffItem(
      5,
      "rerun_live_readiness",
      status === "verified" ? "ready" : "blocked_until_ack_verified",
      "After ack is verified, rerun live readiness aggregation.",
      liveReadinessCheckCommand,
    ),
  ];
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-external-broker-adapter-ack-gate-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-external-broker-adapter-ack-gate-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-external-broker-adapter-ack-gate.json");
  const operatorReview = {
    status: operatorRefreshRequired
      ? "staged_candidate_ready_for_operator_adapter"
      : "no_refresh_required",
    activeAckPath: safeString(ack.path),
    stagedCandidateAckPath,
    requiredTemplatePath,
    expectedSealedIntentSha256: sealedIntentSha256,
    actualSealedIntentSha256,
    activeVsCandidate,
    refreshPlan,
    handoffChecklist,
    candidateAck: expectedAck,
    activeAckWriteSuppressed: true,
    conversationAgentsMayWriteActiveAck: false,
    allowedWriter: "operator-owned-broker-adapter-only",
    validationCommand: adapterAckCheckCommand,
  };
  const machineLine = [
    `capitalAdapterAck=${status}`,
    `sha256=${sealedIntentSha256 || "missing"}`,
    `active=${activeExists}`,
    `hashOk=${hashOk}`,
    `canary=${canaryPass}`,
    `canarySentOrder=${canarySentOrder}`,
    `rollback=${rollbackPass}`,
    `rollbackFresh=${rollbackFresh}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${failed.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "operator_owned_adapter_ack_validation",
    sealedIntentSha256,
    machineLine,
    checks,
    blockers: failed,
    operatorReview,
    ack: {
      status: safeString(ack.status) || status,
      usable: status === "verified",
      activePath: safeString(ack.path),
      exists: activeExists,
      schemaOk,
      ownerOk,
      hashOk,
      canaryPass,
      canaryDryRun,
      canarySentOrder,
      rollbackPass,
      rollbackVerifiedAt,
      rollbackAgeSeconds,
      rollbackMaxFreshSeconds: ACK_ROLLBACK_MAX_FRESH_SECONDS,
      rollbackFresh,
      rollbackFreshnessStatus: rollbackFresh ? "fresh" : "stale",
      adapterId: expectedAck.adapterId,
      requiredTemplatePath,
      sealedIntentHash,
      expectedValue: expectedAck,
      currentValue: currentAck,
    },
    safety: {
      generatedTemplateOnly: true,
      generatedStagedCandidateAck: true,
      wroteActiveAdapterAck: false,
      activeAckWriteSuppressed: true,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
      requiredTemplatePath,
      stagedCandidateAckPath,
    },
    nextSafeTask:
      status === "verified"
        ? "重跑 pnpm capital:live-readiness:check；若 strategy/promotion/operator 仍 blocked，依序關閉剩餘 gate。"
        : !rollbackFresh && hashOk
          ? "由 operator-owned broker adapter 更新 active ack 的 rollback.verifiedAt 為最新已驗證時間；再重跑 pnpm capital:trade:adapter-ack:check。"
          : "由 operator-owned broker adapter 以 required-current template 更新 active ack；再重跑 pnpm capital:trade:adapter-ack:check。",
  };
}

export async function buildCapitalExternalBrokerAdapterAckGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const gate = await buildCapitalLiveOrderDryRunPretradeGate({ repoRoot });
  const currentAck = gate.operatorHandoff?.externalBrokerAdapter?.ack?.path
    ? await fs
        .readFile(gate.operatorHandoff.externalBrokerAdapter.ack.path, "utf8")
        .then((text) => JSON.parse(text.replace(/^\uFEFF/u, "").trim()))
        .catch(() => ({}))
    : {};
  return buildCapitalExternalBrokerAdapterAckReport({ repoRoot, gate, currentAck });
}

async function main() {
  const report = await buildCapitalExternalBrokerAdapterAckGate({ repoRoot: process.cwd() });
  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.requiredTemplatePath, report.ack.expectedValue);
    await writeJsonWithSha(report.paths.stagedCandidateAckPath, report.operatorReview.candidateAck);
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }
  if (hasFlag("--json") || hasFlag("--check")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.machineLine}\n`);
  }
}

if (process.argv[1] === currentFile) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
