#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-executor-profile-rearm-latest.json",
);
const ALLOWED_STATUSES = new Set(["blocked", "ready_for_operator_execute", "rearmed"]);

const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));

assert.equal(report.schema, "openclaw.capital.live-executor-profile-rearm.v1");
assert.ok(ALLOWED_STATUSES.has(report.status), `status=${report.status}`);
assert.equal(typeof report.execute, "boolean");
assert.equal(typeof report.operator, "string");
assert.equal(typeof report.reason, "string");
assert.equal(typeof report.ttlSeconds, "number");
assert.ok(report.ttlSeconds > 0, "ttlSeconds must be > 0");
assert.ok(report.ttlSeconds <= report.maxTtlSeconds, "ttlSeconds exceeds maxTtlSeconds");
assert.equal(report.maxTtlSeconds, 900);
assert.equal(typeof report.operatorSignature, "string");
assert.ok(report.operatorSignature.length >= 12, "operatorSignature too short");
assert.equal(typeof report.armedAt, "string");
assert.equal(typeof report.expiresAt, "string");
assert.equal(typeof report.profileBeforeStatus, "string");
assert.equal(typeof report.profileAfterStatus, "string");
assert.equal(typeof report.candidateProfileSha256, "string");
assert.equal(typeof report.candidateProfile, "object");
assert.equal(report.candidateProfile.armed, true);
assert.equal(report.candidateProfile.allowBrokerWriteWhenAllGatesPass, true);
assert.equal(report.candidateProfile.allowConversationAgentDirectWrite, false);
assert.equal(report.candidateProfile.killSwitch, true);
assert.equal(report.candidateProfile.canaryRequired, true);
assert.equal(report.candidateProfile.rollbackRequired, true);
assert.equal(report.candidateProfile.freshQuoteRequired, true);
assert.equal(report.candidateProfile.verifiedPositionRequired, true);
assert.equal(report.candidateProfile.adapterAckHashRequired, true);
assert.ok(Array.isArray(report.blockers));
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.noLiveOrderSent, true);
assert.equal(report.safety.brokerApiCalled, false);
assert.equal(report.safety.brokerWriteAttempted, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.conversationAgentDirectBrokerWrite, false);
assert.equal(typeof report.safety.activeProfileWritten, "boolean");
assert.equal(typeof report.safety.reportOnly, "boolean");
assert.equal(typeof report.paths.profilePath, "string");
assert.equal(typeof report.paths.templatePath, "string");
assert.equal(typeof report.paths.stagedCandidatePath, "string");
assert.equal(typeof report.paths.reportPath, "string");
assert.equal(typeof report.paths.panelPath, "string");
assert.match(report.machineLine, /capitalLiveExecutorRearm=/);
assert.match(report.machineLine, /sentOrder=false/);

if (report.status === "rearmed") {
  assert.equal(report.safety.activeProfileWritten, true);
  assert.equal(report.safety.reportOnly, false);
  assert.equal(report.profileAfterStatus, "armed");
} else {
  assert.equal(report.safety.activeProfileWritten, false);
  assert.equal(report.safety.reportOnly, true);
}

process.stdout.write(
  [
    "CAPITAL_LIVE_EXECUTOR_PROFILE_REARM_CHECK=OK",
    `status=${report.status}`,
    `execute=${report.execute}`,
    `profileBefore=${report.profileBeforeStatus}`,
    `profileAfter=${report.profileAfterStatus}`,
    `activeProfileWritten=${report.safety.activeProfileWritten}`,
    "sentOrder=false",
  ].join("\n") + "\n",
);
