#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalDirectOperationStatus } from "./openclaw-capital-direct-operation-status.mjs";

const SCHEMA = "openclaw.capital.direct-operation-inputs.v1";

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonIfExists(filePath) {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    check: false,
    json: false,
    writeState: false,
  };
  for (const arg of argv) {
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    }
  }
  return options;
}

function pnpmCommand(repoRoot, scriptName) {
  return `pnpm --dir ${path.resolve(repoRoot)} ${scriptName}`;
}

function buildOperatorSteps(status, repoRoot) {
  const positionTarget = status.summary.nextRequiredFiles.verifiedPositionSnapshot;
  const ackTarget = status.summary.nextRequiredFiles.externalBrokerAdapterAck;
  const positionHandoff = status.summary.position.handoff ?? {};
  return [
    {
      id: "verified_position_snapshot",
      owner: "operator",
      activePath: positionTarget.path,
      templatePath: "",
      stagedRefreshPath: positionHandoff.stagedRefreshPath ?? "",
      freshnessStatus: status.summary.position.freshnessStatus,
      verifiedAgeSeconds: status.summary.position.verifiedAgeSeconds,
      maxFreshSeconds: status.summary.position.maxFreshSeconds,
      action: "依實際券商端持倉填入 symbol/side/qty，確認 verified=true 後才寫入正式路徑。",
      validation: pnpmCommand(repoRoot, "capital:trade:direct:status:check"),
    },
    {
      id: "external_broker_adapter_ack",
      owner: "operator_owned_broker_adapter",
      activePath: ackTarget.path,
      templatePath: "",
      requiredCurrentTemplatePath: "",
      action:
        "由 operator-owned adapter 讀取 required-current template，做 canary dry-run 與 rollback 驗證後，寫入 matching sealedIntentSha256 的 ack。",
      validation: pnpmCommand(repoRoot, "capital:trade:adapter-ack:check"),
    },
  ];
}

function buildPositionRefreshCandidate(status, activePositionSnapshot, repoRoot) {
  const positionTarget = status.summary.nextRequiredFiles.verifiedPositionSnapshot;
  const positions = Array.isArray(activePositionSnapshot?.positions)
    ? activePositionSnapshot.positions
    : positionTarget.template.positions;
  return {
    ...positionTarget.template,
    verified: false,
    verifiedAt: "REPLACE_WITH_CURRENT_BROKER_VERIFIED_AT_ISO8601",
    verifiedBy: "operator",
    positions,
    stagingMode: "operator_position_snapshot_refresh_candidate",
    activeSnapshotPath: positionTarget.path,
    templatePath: status.summary.position.handoff.templatePath,
    operatorReviewStatus: "manual_operator_position_refresh_required",
    validationCommand: pnpmCommand(repoRoot, "capital:trade:direct:status:check"),
    activeSnapshotWriteSuppressed: true,
    allowedWriter: "operator-owned-position-query-only",
    refreshRules: {
      mustQueryBrokerPosition: true,
      mustSetVerifiedTrueOnlyInActiveSnapshot: true,
      mustSetCurrentVerifiedAt: true,
      mustPreserveSchema: true,
      mustRerunDirectStatusCheck: true,
      mustRerunLiveReadinessCheck: true,
    },
  };
}

function buildAdapterAckRefreshReview({
  status,
  activeAdapterAck,
  ackTarget,
  ackTemplatePath,
  ackRequiredCurrentTemplatePath,
  stagedAdapterAckCandidatePath,
  repoRoot,
}) {
  const refreshPlan = status.summary.externalBrokerAdapter.handoff?.refreshPlan ?? {};
  const expectedSealedIntentSha256 = status.summary.sealedOrderIntent.sha256 || "";
  const actualSealedIntentSha256 =
    typeof activeAdapterAck?.sealedIntentSha256 === "string"
      ? activeAdapterAck.sealedIntentSha256
      : "";
  const hashOk =
    actualSealedIntentSha256.length > 0 && actualSealedIntentSha256 === expectedSealedIntentSha256;
  const validationCommand = pnpmCommand(repoRoot, "capital:trade:adapter-ack:check");
  const postRefreshValidationCommand = pnpmCommand(repoRoot, "capital:live-readiness:check");

  return {
    status: hashOk ? "not_required" : "operator_refresh_required",
    reason: hashOk ? "active_ack_matches_current_sealed_intent" : "active_ack_hash_mismatch",
    activeAckPath: ackTarget.path,
    templatePath: ackTemplatePath,
    requiredCurrentTemplatePath: ackRequiredCurrentTemplatePath,
    stagedCandidateAckPath: refreshPlan.sourcePath || stagedAdapterAckCandidatePath,
    destinationPath: refreshPlan.destinationPath || ackTarget.path,
    expectedSealedIntentSha256,
    actualSealedIntentSha256,
    candidateSealedIntentSha256: expectedSealedIntentSha256,
    activeVsCandidateStatus: hashOk ? "matching" : "mismatch",
    canaryPass: refreshPlan.canaryPass === true,
    canarySentOrder: refreshPlan.canarySentOrder === true,
    rollbackPass: refreshPlan.rollbackPass === true,
    rollbackFresh: refreshPlan.rollbackFresh === true,
    safeToPromoteCandidate:
      !hashOk &&
      expectedSealedIntentSha256.length > 0 &&
      refreshPlan.safeToPromoteCandidate === true,
    activeAckWriteSuppressed: true,
    conversationAgentsMayWriteActiveAck: false,
    allowedWriter: "operator-owned-broker-adapter-only",
    validationCommand,
    postRefreshValidationCommand,
    candidateAck: ackTarget.template,
    refreshRules: {
      mustReviewStagedCandidate: true,
      mustMatchCurrentSealedIntentSha256: true,
      mustKeepCanaryDryRun: true,
      mustKeepCanarySentOrderFalse: true,
      mustVerifyRollbackFresh: true,
      mustWriteActiveAckOnlyFromOperatorOwnedAdapter: true,
      mustRerunAdapterAckCheck: true,
      mustRerunLiveReadinessCheck: true,
    },
    handoffChecklist: [
      {
        order: 1,
        id: "review_staged_candidate_ack",
        status: hashOk ? "complete" : "pending",
        validationCommand,
      },
      {
        order: 2,
        id: "operator_owned_active_ack_refresh",
        status: hashOk ? "complete" : "pending_operator_owned_adapter",
        validationCommand,
      },
      {
        order: 3,
        id: "rerun_live_readiness",
        status: hashOk ? "ready" : "blocked_until_ack_verified",
        validationCommand: postRefreshValidationCommand,
      },
    ],
  };
}

function renderMarkdown(report) {
  return [
    "# Capital Direct Operation Inputs",
    "",
    `generatedAt: ${report.generatedAt}`,
    `status: ${report.status}`,
    `requestedTrade: ${report.requestedTrade.instrument} / ${report.requestedTrade.holdingMode}`,
    `sealedIntentSha256: ${report.sealedIntentSha256}`,
    "",
    "## Templates",
    "",
    `- Position template: ${report.templates.verifiedPositionSnapshot.path}`,
    `- Position staged refresh: ${report.operatorReviews.verifiedPositionSnapshotRefresh.stagedRefreshPath}`,
    `- Adapter ack template: ${report.templates.externalBrokerAdapterAck.path}`,
    `- Adapter ack required-current template: ${report.templates.externalBrokerAdapterAckRequiredCurrent.path}`,
    "",
    "## Active Targets",
    "",
    `- Position active path: ${report.activeTargets.verifiedPositionSnapshot.path}`,
    `- Position freshness: ${report.activeTargets.verifiedPositionSnapshot.freshnessStatus}`,
    `- Adapter ack active path: ${report.activeTargets.externalBrokerAdapterAck.path}`,
    `- Adapter ack expected hash: ${report.activeTargets.externalBrokerAdapterAck.expectedSealedIntentSha256}`,
    `- Adapter ack active hash: ${report.activeTargets.externalBrokerAdapterAck.actualSealedIntentSha256 || "missing"}`,
    `- Adapter ack hashOk: ${report.activeTargets.externalBrokerAdapterAck.hashOk}`,
    "",
    "## Safety",
    "",
    `- generatedTemplatesOnly: ${report.safety.generatedTemplatesOnly}`,
    `- wroteActivePositionSnapshot: ${report.safety.wroteActivePositionSnapshot}`,
    `- wroteActiveAdapterAck: ${report.safety.wroteActiveAdapterAck}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    "",
  ].join("\n");
}

export async function buildCapitalDirectOperationInputs(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const templateRoot = path.join(tradingRoot, "templates");
  const status = await buildCapitalDirectOperationStatus({ repoRoot });
  const positionTarget = status.summary.nextRequiredFiles.verifiedPositionSnapshot;
  const ackTarget = status.summary.nextRequiredFiles.externalBrokerAdapterAck;
  const positionTemplatePath = path.join(
    templateRoot,
    "capital-verified-position-snapshot.template.json",
  );
  const ackTemplatePath = path.join(
    templateRoot,
    "capital-external-broker-adapter-ack.template.json",
  );
  const ackRequiredCurrentTemplatePath = path.join(
    templateRoot,
    "capital-external-broker-adapter-ack.required-current.json",
  );
  const stagedPositionSnapshotRefreshPath = path.join(
    tradingRoot,
    "staging",
    "capital-verified-position-snapshot.staged-refresh.json",
  );
  const stagedAdapterAckCandidatePath =
    status.summary.externalBrokerAdapter.handoff?.refreshPlan?.sourcePath ||
    path.join(tradingRoot, "staging", "capital-external-broker-adapter-ack.staged-current.json");
  const reportPath = path.join(stateRoot, "openclaw-capital-direct-operation-inputs-latest.json");
  const markdownPath = path.join(stateRoot, "openclaw-capital-direct-operation-inputs-latest.md");
  const panelPath = path.join(tradingRoot, "capital-direct-operation-inputs.json");
  const [activePositionSnapshot, activeAdapterAck] = await Promise.all([
    readJsonIfExists(positionTarget.path),
    readJsonIfExists(ackTarget.path),
  ]);
  const expectedAckSealedIntentSha256 = status.summary.sealedOrderIntent.sha256 || "";
  const actualAckSealedIntentSha256 =
    typeof activeAdapterAck?.sealedIntentSha256 === "string"
      ? activeAdapterAck.sealedIntentSha256
      : "";
  const ackHashOk =
    actualAckSealedIntentSha256.length > 0 &&
    actualAckSealedIntentSha256 === expectedAckSealedIntentSha256;
  const steps = buildOperatorSteps(status, repoRoot);
  steps[0].templatePath = positionTemplatePath;
  steps[0].stagedRefreshPath = stagedPositionSnapshotRefreshPath;
  steps[1].templatePath = ackTemplatePath;
  steps[1].requiredCurrentTemplatePath = ackRequiredCurrentTemplatePath;
  const positionRefreshCandidate = buildPositionRefreshCandidate(
    status,
    activePositionSnapshot,
    repoRoot,
  );
  const adapterAckRefreshReview = buildAdapterAckRefreshReview({
    status,
    activeAdapterAck,
    ackTarget,
    ackTemplatePath,
    ackRequiredCurrentTemplatePath,
    stagedAdapterAckCandidatePath,
    repoRoot,
  });
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot,
    status: "ready",
    mode: "operator_input_templates_only",
    requestedTrade: status.summary.requestedTrade,
    sealedIntentSha256: status.summary.sealedOrderIntent.sha256,
    templates: {
      verifiedPositionSnapshot: {
        path: positionTemplatePath,
        schema: positionTarget.schema,
        value: positionTarget.template,
      },
      externalBrokerAdapterAck: {
        path: ackTemplatePath,
        schema: ackTarget.schema,
        value: ackTarget.template,
      },
      externalBrokerAdapterAckRequiredCurrent: {
        path: ackRequiredCurrentTemplatePath,
        schema: ackTarget.schema,
        value: ackTarget.template,
      },
    },
    activeTargets: {
      verifiedPositionSnapshot: {
        path: positionTarget.path,
        exists: activePositionSnapshot != null,
        status: status.summary.position.status,
        usable: status.summary.position.usable,
        verifiedAt: status.summary.position.verifiedAt,
        verifiedBy: status.summary.position.verifiedBy,
        verifiedAgeSeconds: status.summary.position.verifiedAgeSeconds,
        maxFreshSeconds: status.summary.position.maxFreshSeconds,
        freshnessStatus: status.summary.position.freshnessStatus,
        stagedRefreshPath: stagedPositionSnapshotRefreshPath,
      },
      externalBrokerAdapterAck: {
        path: ackTarget.path,
        exists: activeAdapterAck != null,
        status: status.summary.externalBrokerAdapter.ackStatus,
        usable: status.summary.externalBrokerAdapter.ackUsable,
        expectedSealedIntentSha256: expectedAckSealedIntentSha256,
        actualSealedIntentSha256: actualAckSealedIntentSha256,
        hashOk: ackHashOk,
      },
    },
    operatorReviews: {
      verifiedPositionSnapshotRefresh: {
        status: status.summary.position.handoff.status,
        activeSnapshotPath: positionTarget.path,
        templatePath: positionTemplatePath,
        stagedRefreshPath: stagedPositionSnapshotRefreshPath,
        activeSnapshotWriteSuppressed: true,
        conversationAgentsMayWriteActiveSnapshot: false,
        allowedWriter: "operator-owned-position-query-only",
        validationCommand: pnpmCommand(repoRoot, "capital:trade:direct:status:check"),
        candidateSnapshot: positionRefreshCandidate,
      },
      externalBrokerAdapterAckRefresh: adapterAckRefreshReview,
    },
    operatorSteps: steps,
    safety: {
      generatedTemplatesOnly: true,
      wroteActivePositionSnapshot: false,
      wroteActiveAdapterAck: false,
      generatedStagedAdapterAckCandidate: true,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
      stagedPositionSnapshotRefreshPath,
      stagedAdapterAckCandidatePath,
    },
    nextSafeTask: `由 operator-owned broker adapter 讀取 required-current ack template 更新 active ack；再重跑 ${pnpmCommand(repoRoot, "capital:trade:adapter-ack:check")}。`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalDirectOperationInputs({ repoRoot: process.cwd() });
  if (options.writeState || options.check) {
    await writeJsonWithSha(
      report.templates.verifiedPositionSnapshot.path,
      report.templates.verifiedPositionSnapshot.value,
    );
    await writeJsonWithSha(
      report.paths.stagedPositionSnapshotRefreshPath,
      report.operatorReviews.verifiedPositionSnapshotRefresh.candidateSnapshot,
    );
    await writeJsonWithSha(
      report.templates.externalBrokerAdapterAck.path,
      report.templates.externalBrokerAdapterAck.value,
    );
    await writeJsonWithSha(
      report.templates.externalBrokerAdapterAckRequiredCurrent.path,
      report.templates.externalBrokerAdapterAckRequiredCurrent.value,
    );
    await writeJsonWithSha(
      report.paths.stagedAdapterAckCandidatePath,
      report.operatorReviews.externalBrokerAdapterAckRefresh.candidateAck,
    );
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }
  if (options.check) {
    if (!report.safety.generatedTemplatesOnly || (report.safety.sentOrder ?? true)) {
      throw new Error("CAPITAL_DIRECT_OPERATION_INPUTS_SAFETY_MISMATCH");
    }
  }
  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `CAPITAL_DIRECT_OPERATION_INPUTS=${report.status} positionTemplate=${report.templates.verifiedPositionSnapshot.path} ackTemplate=${report.templates.externalBrokerAdapterAck.path} sentOrder=${report.safety.sentOrder}\n`,
    );
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
