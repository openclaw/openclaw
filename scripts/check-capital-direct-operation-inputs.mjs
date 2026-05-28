#!/usr/bin/env node
import { buildCapitalDirectOperationInputs } from "./openclaw-capital-direct-operation-inputs.mjs";

const report = await buildCapitalDirectOperationInputs({ repoRoot: process.cwd() });
const issues = [];

function isRepoRootPnpmCommand(value) {
  return /^pnpm --dir .+ /u.test(String(value || ""));
}

if (report.schema !== "openclaw.capital.direct-operation-inputs.v1") {
  issues.push("schema mismatch");
}
if (report.status !== "ready") {
  issues.push(`status=${report.status}`);
}
if (report.mode !== "operator_input_templates_only") {
  issues.push(`mode=${report.mode}`);
}
if (report.safety?.generatedTemplatesOnly !== true) {
  issues.push("generatedTemplatesOnly must be true");
}
if (report.safety?.wroteActivePositionSnapshot !== false) {
  issues.push("must not write active position snapshot");
}
if (report.safety?.wroteActiveAdapterAck !== false) {
  issues.push("must not write active adapter ack");
}
if (report.safety?.generatedStagedAdapterAckCandidate !== true) {
  issues.push("must generate staged adapter ack candidate");
}
if (report.safety?.sentOrder !== false || report.safety?.noLiveOrderSent !== true) {
  issues.push("order safety mismatch");
}
if (!report.sealedIntentSha256) {
  issues.push("sealed intent hash missing");
}
if (report.requestedTrade?.instrument !== "A50 202605") {
  issues.push("requested A50 202605 trade missing");
}
if (!String(report.templates?.verifiedPositionSnapshot?.path || "").endsWith(".template.json")) {
  issues.push("position template path must be a template");
}
if (
  !String(report.paths?.stagedPositionSnapshotRefreshPath || "").endsWith(".staged-refresh.json")
) {
  issues.push("position staged refresh path missing");
}
if (!String(report.templates?.externalBrokerAdapterAck?.path || "").endsWith(".template.json")) {
  issues.push("ack template path must be a template");
}
if (
  !String(report.templates?.externalBrokerAdapterAckRequiredCurrent?.path || "").endsWith(
    ".required-current.json",
  )
) {
  issues.push("ack required-current template path must be required-current");
}
if (
  report.templates?.externalBrokerAdapterAckRequiredCurrent?.value?.sealedIntentSha256 !==
  report.sealedIntentSha256
) {
  issues.push("ack required-current template must match sealed intent hash");
}
if (
  report.templates?.verifiedPositionSnapshot?.path ===
  report.activeTargets?.verifiedPositionSnapshot?.path
) {
  issues.push("position template must not equal active target");
}
if (!["fresh", "stale"].includes(report.activeTargets?.verifiedPositionSnapshot?.freshnessStatus)) {
  issues.push("position snapshot freshness status missing");
}
if (!Number.isFinite(Number(report.activeTargets?.verifiedPositionSnapshot?.verifiedAgeSeconds))) {
  issues.push("position snapshot verified age missing");
}
if (
  report.activeTargets?.verifiedPositionSnapshot?.stagedRefreshPath !==
  report.paths?.stagedPositionSnapshotRefreshPath
) {
  issues.push("position active target staged refresh path mismatch");
}
const positionReview = report.operatorReviews?.verifiedPositionSnapshotRefresh;
if (!positionReview || typeof positionReview !== "object") {
  issues.push("position refresh operator review missing");
} else {
  if (
    !["fresh", "stale_operator_refresh_required", "missing_operator_refresh_required"].includes(
      positionReview.status,
    )
  ) {
    issues.push(`position review status=${positionReview.status}`);
  }
  if (positionReview.activeSnapshotPath !== report.activeTargets?.verifiedPositionSnapshot?.path) {
    issues.push("position review active path mismatch");
  }
  if (positionReview.templatePath !== report.templates?.verifiedPositionSnapshot?.path) {
    issues.push("position review template path mismatch");
  }
  if (positionReview.stagedRefreshPath !== report.paths?.stagedPositionSnapshotRefreshPath) {
    issues.push("position review staged refresh path mismatch");
  }
  if (positionReview.activeSnapshotWriteSuppressed !== true) {
    issues.push("position review must suppress active writes");
  }
  if (positionReview.conversationAgentsMayWriteActiveSnapshot !== false) {
    issues.push("conversation agents must not write active position snapshot");
  }
  if (positionReview.candidateSnapshot?.verified !== false) {
    issues.push("position staged refresh candidate must remain unverified");
  }
  if (positionReview.candidateSnapshot?.activeSnapshotWriteSuppressed !== true) {
    issues.push("position candidate must suppress active writes");
  }
  if (!isRepoRootPnpmCommand(positionReview.validationCommand)) {
    issues.push("position review validation command must be repo-root qualified");
  }
}
if (
  report.templates?.externalBrokerAdapterAck?.path ===
  report.activeTargets?.externalBrokerAdapterAck?.path
) {
  issues.push("ack template must not equal active target");
}
if (
  report.templates?.externalBrokerAdapterAckRequiredCurrent?.path ===
  report.activeTargets?.externalBrokerAdapterAck?.path
) {
  issues.push("ack required-current template must not equal active target");
}
if (
  report.activeTargets?.externalBrokerAdapterAck?.expectedSealedIntentSha256 !==
  report.sealedIntentSha256
) {
  issues.push("ack expected hash must match sealed intent hash");
}
if (typeof report.activeTargets?.externalBrokerAdapterAck?.actualSealedIntentSha256 !== "string") {
  issues.push("ack actual hash must be a string");
}
if (typeof report.activeTargets?.externalBrokerAdapterAck?.hashOk !== "boolean") {
  issues.push("ack hashOk must be boolean");
}
if (!Array.isArray(report.operatorSteps) || report.operatorSteps.length < 2) {
  issues.push("operator steps missing");
}
const ackStep = report.operatorSteps?.find((step) => step?.id === "external_broker_adapter_ack");
if (!String(ackStep?.requiredCurrentTemplatePath || "").endsWith(".required-current.json")) {
  issues.push("operator ack step required-current template missing");
}
if (!isRepoRootPnpmCommand(ackStep?.validation)) {
  issues.push("operator ack validation command must be repo-root qualified");
}
const positionStep = report.operatorSteps?.find(
  (step) => step?.id === "verified_position_snapshot",
);
if (!String(positionStep?.stagedRefreshPath || "").endsWith(".staged-refresh.json")) {
  issues.push("operator position step staged refresh missing");
}
if (!isRepoRootPnpmCommand(positionStep?.validation)) {
  issues.push("operator position validation command must be repo-root qualified");
}

const ackReview = report.operatorReviews?.externalBrokerAdapterAckRefresh;
if (!ackReview || typeof ackReview !== "object") {
  issues.push("adapter ack refresh operator review missing");
} else {
  if (!["not_required", "operator_refresh_required"].includes(ackReview.status)) {
    issues.push(`adapter ack review status=${ackReview.status}`);
  }
  if (
    ackReview.status === "operator_refresh_required" &&
    ackReview.reason !== "active_ack_hash_mismatch"
  ) {
    issues.push(`adapter ack refresh reason=${ackReview.reason}`);
  }
  if (ackReview.activeAckPath !== report.activeTargets?.externalBrokerAdapterAck?.path) {
    issues.push("adapter ack review active path mismatch");
  }
  if (
    ackReview.requiredCurrentTemplatePath !==
    report.templates?.externalBrokerAdapterAckRequiredCurrent?.path
  ) {
    issues.push("adapter ack review required-current path mismatch");
  }
  if (ackReview.stagedCandidateAckPath !== report.paths?.stagedAdapterAckCandidatePath) {
    issues.push("adapter ack review staged candidate path mismatch");
  }
  if (ackReview.destinationPath !== report.activeTargets?.externalBrokerAdapterAck?.path) {
    issues.push("adapter ack review destination path mismatch");
  }
  if (ackReview.expectedSealedIntentSha256 !== report.sealedIntentSha256) {
    issues.push("adapter ack review expected hash mismatch");
  }
  if (ackReview.candidateSealedIntentSha256 !== report.sealedIntentSha256) {
    issues.push("adapter ack review candidate hash mismatch");
  }
  if (ackReview.candidateAck?.sealedIntentSha256 !== report.sealedIntentSha256) {
    issues.push("adapter ack staged candidate must match sealed intent hash");
  }
  if (ackReview.activeAckWriteSuppressed !== true) {
    issues.push("adapter ack review must suppress active writes");
  }
  if (ackReview.conversationAgentsMayWriteActiveAck !== false) {
    issues.push("conversation agents must not write active adapter ack");
  }
  if (ackReview.allowedWriter !== "operator-owned-broker-adapter-only") {
    issues.push("adapter ack review allowed writer mismatch");
  }
  if (!isRepoRootPnpmCommand(ackReview.validationCommand)) {
    issues.push("adapter ack review validation command must be repo-root qualified");
  }
  if (!isRepoRootPnpmCommand(ackReview.postRefreshValidationCommand)) {
    issues.push("adapter ack review post-refresh validation command must be repo-root qualified");
  }
  if (!Array.isArray(ackReview.handoffChecklist) || ackReview.handoffChecklist.length < 3) {
    issues.push("adapter ack handoff checklist missing");
  } else {
    for (const item of ackReview.handoffChecklist) {
      if (!isRepoRootPnpmCommand(item?.validationCommand)) {
        issues.push(
          `adapter ack handoff ${item?.id || "unknown"} validation command must be repo-root qualified`,
        );
      }
    }
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_DIRECT_OPERATION_INPUTS_CHECK=FAIL issues=${issues.join(";")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_DIRECT_OPERATION_INPUTS_CHECK=OK status=${report.status} templatesOnly=${report.safety.generatedTemplatesOnly} requestedTrade=${report.requestedTrade.instrument} sentOrder=${report.safety.sentOrder}\n`,
  );
}
