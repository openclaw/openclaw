#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildCapitalLiveExecutorArmProfile } from "./openclaw-capital-live-executor-arm-profile.mjs";

const report = await buildCapitalLiveExecutorArmProfile();

function assertRepoRootPnpmCommand(command, fieldName) {
  assert.match(
    String(command || ""),
    /^pnpm --dir .+ /,
    `${fieldName} must be repo-root qualified`,
  );
}

assert.equal(report.schema, "openclaw.capital.live-executor-arm-profile.v1");
assert.ok(["unarmed", "armed", "expired", "blocked_invalid"].includes(report.status));
assert.equal(report.executorId, "openclaw-managed-capital-live-executor");
assert.equal(report.brokerWriteAuthorityTarget, "openclaw_managed_local_broker_executor");
assert.equal(report.allowConversationAgentDirectWrite, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.noLiveOrderSent, true);
assert.equal(report.safety.brokerWriteAttempted, false);
assert.equal(report.safety.generatedStagedRearmProfile, true);
assert.equal(report.safety.wroteActiveArmProfile, false);
assert.equal(report.safety.activeArmProfileWriteSuppressed, true);
assert.equal(report.safety.conversationAgentDirectBrokerWrite, false);
assert.equal(report.safety.reportOnly, true);
assert.equal(report.requirements.killSwitch, true);
assert.equal(report.requirements.canaryRequired, true);
assert.equal(report.requirements.rollbackRequired, true);
assert.equal(report.requirements.freshQuoteRequired, true);
assert.equal(report.requirements.verifiedPositionRequired, true);
assert.equal(report.requirements.adapterAckHashRequired, true);
assert.equal(report.template.schema, report.schema);
assert.equal(report.template.allowConversationAgentDirectWrite, false);
assert.equal(report.template.brokerWriteAuthorityTarget, report.brokerWriteAuthorityTarget);
assert.equal(report.template.armed, false);
assert.ok(report.machineLine.includes("noOrderWrite=true"));
assert.ok(report.machineLine.includes("sentOrder=false"));
assert.ok(report.paths.profilePath.endsWith("capital-live-executor-arm-profile.json"));
assert.ok(report.paths.templatePath.endsWith("capital-live-executor-arm-profile.template.json"));
assert.ok(
  report.paths.stagedRearmProfilePath.endsWith(
    "capital-live-executor-arm-profile.staged-rearm.json",
  ),
);
assert.equal(report.operatorReview.activeProfilePath, report.paths.profilePath);
assert.equal(report.operatorReview.stagedRearmProfilePath, report.paths.stagedRearmProfilePath);
assert.notEqual(
  report.operatorReview.stagedRearmProfilePath,
  report.operatorReview.activeProfilePath,
);
assert.equal(report.operatorReview.activeProfileWriteSuppressed, true);
assert.equal(report.operatorReview.conversationAgentsMayWriteActiveProfile, false);
assert.equal(report.operatorReview.allowedWriter, "operator-managed-local-broker-executor-only");
assert.equal(
  report.operatorReview.validationCommand,
  `pnpm --dir ${report.paths.repoRoot} capital:trade:live-executor-profile:check`,
);
assertRepoRootPnpmCommand(
  report.operatorReview.validationCommand,
  "operatorReview.validationCommand",
);
assert.equal(
  report.operatorReview.postRearmValidationCommand,
  `pnpm --dir ${report.paths.repoRoot} capital:live-readiness:check`,
);
assertRepoRootPnpmCommand(
  report.operatorReview.postRearmValidationCommand,
  "operatorReview.postRearmValidationCommand",
);
assert.ok(Array.isArray(report.operatorReview.handoffChecklist));
assert.ok(report.operatorReview.handoffChecklist.length >= 3);
for (const item of report.operatorReview.handoffChecklist) {
  assertRepoRootPnpmCommand(
    item?.validationCommand,
    `operatorReview.handoffChecklist.${item?.id || "unknown"}.validationCommand`,
  );
}
assert.equal(report.operatorReview.rearmCandidate.armed, false);
assert.equal(report.operatorReview.rearmCandidate.allowBrokerWriteWhenAllGatesPass, false);
assert.equal(report.operatorReview.rearmCandidate.allowConversationAgentDirectWrite, false);
assert.equal(report.operatorReview.rearmCandidate.activeProfileWriteSuppressed, true);
assert.equal(report.operatorReview.rearmCandidate.activeProfilePath, report.paths.profilePath);
assertRepoRootPnpmCommand(
  report.operatorReview.rearmCandidate.validationCommand,
  "operatorReview.rearmCandidate.validationCommand",
);

if (report.status === "armed") {
  assert.equal(report.armed, true);
  assert.equal(report.allowBrokerWriteWhenAllGatesPass, true);
  assert.equal(report.operatorSignaturePresent, true);
  assert.equal(report.expired, false);
  assert.ok(Number(report.ttlSeconds) > 0);
  assert.ok(Number(report.ttlSeconds) <= report.maxTtlSeconds);
} else {
  assert.equal(report.allowBrokerWriteWhenAllGatesPass, false);
  assert.equal(report.operatorReview.status, "staged_rearm_candidate_ready_for_operator");
}

process.stdout.write(
  [
    "CAPITAL_LIVE_EXECUTOR_ARM_PROFILE_CHECK=OK",
    `status=${report.status}`,
    `armed=${report.armed}`,
    `allowExecutorWrite=${report.allowBrokerWriteWhenAllGatesPass}`,
    `sentOrder=${report.safety.sentOrder}`,
  ].join("\n") + "\n",
);
