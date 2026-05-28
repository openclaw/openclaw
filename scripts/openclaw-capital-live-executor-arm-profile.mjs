#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.live-executor-arm-profile.v1";
const EXECUTOR_ID = "openclaw-managed-capital-live-executor";
const BROKER_WRITE_TARGET = "openclaw_managed_local_broker_executor";
const MAX_TTL_SECONDS = 900;
export const CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD = "allowBrokerWriteWhenAllGatesPass";
export const CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_DEPRECATED_FIELD = "allowExecutorWrite";
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_PROFILE_PATH = path.join(
  repoRoot,
  ".openclaw",
  "trading",
  "capital-live-executor-arm-profile.json",
);
const DEFAULT_TEMPLATE_PATH = path.join(
  repoRoot,
  ".openclaw",
  "trading",
  "templates",
  "capital-live-executor-arm-profile.template.json",
);
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-executor-arm-profile-latest.json",
);
const DEFAULT_MD_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-executor-arm-profile-latest.md",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
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

async function readJsonOptional(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(text), error: "" };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { ok: false, value: null, error: "missing" };
    }
    return {
      ok: false,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseIsoMillis(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function buildTemplate(generatedAt) {
  return {
    schema: SCHEMA,
    executorId: EXECUTOR_ID,
    mode: "operator_managed_live_executor_arm_profile",
    armed: false,
    operatorSignature: "REPLACE_WITH_OPERATOR_CONFIRMATION",
    armedAt: "REPLACE_WITH_ARMED_AT_ISO8601",
    expiresAt: "REPLACE_WITH_EXPIRES_AT_ISO8601_MAX_15M",
    maxTtlSeconds: MAX_TTL_SECONDS,
    brokerWriteAuthorityTarget: BROKER_WRITE_TARGET,
    [CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD]: false,
    allowConversationAgentDirectWrite: false,
    killSwitch: true,
    canaryRequired: true,
    rollbackRequired: true,
    freshQuoteRequired: true,
    verifiedPositionRequired: true,
    adapterAckHashRequired: true,
    generatedAt,
    note: "Copy to .openclaw/trading/capital-live-executor-arm-profile.json only when the local broker executor is intentionally armed.",
  };
}

function pnpmCommand(root, scriptName) {
  return `pnpm --dir ${path.resolve(root)} ${scriptName}`;
}

function buildStagedRearmProfile({ generatedAt, profilePath, templatePath, repoRoot }) {
  return {
    ...buildTemplate(generatedAt),
    stagingMode: "operator_rearm_review_candidate",
    activeProfilePath: profilePath,
    templatePath,
    operatorReviewStatus: "manual_operator_rearm_required",
    validationCommand: pnpmCommand(repoRoot, "capital:trade:live-executor-profile:check"),
    activeProfileWriteSuppressed: true,
    allowedWriter: "operator-managed-local-broker-executor-only",
    rearmRules: {
      mustSetArmedTrueOnlyInActiveProfile: true,
      mustSetOperatorSignature: true,
      maxTtlSeconds: MAX_TTL_SECONDS,
      mustKeepAllowConversationAgentDirectWriteFalse: true,
      mustKeepKillSwitchTrue: true,
      mustVerifyFreshQuote: true,
      mustVerifyPosition: true,
      mustVerifyAdapterAckHash: true,
      mustRunCanaryAndRollback: true,
    },
  };
}

function normalizeProfile(profile) {
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
}

function buildMarkdown(report) {
  return [
    "# Capital Live Executor Arm Profile",
    "",
    `- status: ${report.status}`,
    `- armed: ${report.armed}`,
    `- allowBrokerWriteWhenAllGatesPass: ${report.allowBrokerWriteWhenAllGatesPass}`,
    `- allowConversationAgentDirectWrite: ${report.allowConversationAgentDirectWrite}`,
    `- brokerWriteAuthorityTarget: ${report.brokerWriteAuthorityTarget}`,
    `- expiresAt: ${report.expiresAt || "missing"}`,
    `- stagedRearmProfilePath: ${report.operatorReview.stagedRearmProfilePath}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    `- noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `- machineLine: ${report.machineLine}`,
    "",
    "## Blockers",
    ...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

export async function buildCapitalLiveExecutorArmProfile(options = {}) {
  const resolvedRepoRoot = path.resolve(options.repoRoot ?? repoRoot);
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const nowMillis = Date.parse(generatedAt);
  const profilePath = path.resolve(options.profilePath || DEFAULT_PROFILE_PATH);
  const templatePath = path.resolve(options.templatePath || DEFAULT_TEMPLATE_PATH);
  const stagedRearmProfilePath = path.resolve(
    options.stagedRearmProfilePath ||
      path.join(
        resolvedRepoRoot,
        ".openclaw",
        "trading",
        "staging",
        "capital-live-executor-arm-profile.staged-rearm.json",
      ),
  );
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const markdownPath = path.resolve(options.markdownPath || DEFAULT_MD_PATH);
  const profileRead =
    options.profile && typeof options.profile === "object"
      ? { ok: true, value: options.profile, error: "" }
      : await readJsonOptional(profilePath);
  const profile = normalizeProfile(profileRead.value);
  const profileExists = profileRead.ok === true;
  const schemaOk = profile.schema === SCHEMA;
  const executorIdOk = profile.executorId === EXECUTOR_ID;
  const brokerTargetOk = profile.brokerWriteAuthorityTarget === BROKER_WRITE_TARGET;
  const directAgentWriteDisabled = profile.allowConversationAgentDirectWrite === false;
  const armed = profile.armed === true;
  const allowFlag = profile[CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD] === true;
  const killSwitchReady = profile.killSwitch === true;
  const canaryRequired = profile.canaryRequired === true;
  const rollbackRequired = profile.rollbackRequired === true;
  const freshQuoteRequired = profile.freshQuoteRequired === true;
  const verifiedPositionRequired = profile.verifiedPositionRequired === true;
  const adapterAckHashRequired = profile.adapterAckHashRequired === true;
  const operatorSignaturePresent =
    typeof profile.operatorSignature === "string" &&
    profile.operatorSignature.trim().length >= 12 &&
    !profile.operatorSignature.includes("REPLACE_WITH");
  const armedAtMillis = parseIsoMillis(profile.armedAt);
  const expiresAtMillis = parseIsoMillis(profile.expiresAt);
  const armedAtOk = Number.isFinite(armedAtMillis);
  const expiresAtOk = Number.isFinite(expiresAtMillis);
  const ttlSeconds =
    armedAtOk && expiresAtOk
      ? Math.max(0, Math.round((expiresAtMillis - armedAtMillis) / 1000))
      : null;
  const ttlOk = ttlSeconds !== null && ttlSeconds > 0 && ttlSeconds <= MAX_TTL_SECONDS;
  const expired = expiresAtOk && expiresAtMillis <= nowMillis;
  const staticContractOk =
    schemaOk &&
    executorIdOk &&
    brokerTargetOk &&
    directAgentWriteDisabled &&
    killSwitchReady &&
    canaryRequired &&
    rollbackRequired &&
    freshQuoteRequired &&
    verifiedPositionRequired &&
    adapterAckHashRequired;
  const armedContractOk =
    armed &&
    allowFlag &&
    staticContractOk &&
    operatorSignaturePresent &&
    armedAtOk &&
    expiresAtOk &&
    ttlOk &&
    !expired;
  const status = profileExists
    ? !staticContractOk
      ? "blocked_invalid"
      : expired && armed
        ? "expired"
        : armedContractOk
          ? "armed"
          : "unarmed"
    : "unarmed";
  const allowBrokerWriteWhenAllGatesPass = status === "armed";
  const stagedRearmProfile = buildStagedRearmProfile({
    generatedAt,
    profilePath,
    templatePath,
    repoRoot: resolvedRepoRoot,
  });
  const profileCheckCommand = pnpmCommand(
    resolvedRepoRoot,
    "capital:trade:live-executor-profile:check",
  );
  const liveReadinessCheckCommand = pnpmCommand(resolvedRepoRoot, "capital:live-readiness:check");
  const operatorReview = {
    status: allowBrokerWriteWhenAllGatesPass
      ? "no_rearm_required"
      : "staged_rearm_candidate_ready_for_operator",
    activeProfilePath: profilePath,
    stagedRearmProfilePath,
    templatePath,
    activeProfileWriteSuppressed: true,
    conversationAgentsMayWriteActiveProfile: false,
    allowedWriter: "operator-managed-local-broker-executor-only",
    validationCommand: profileCheckCommand,
    postRearmValidationCommand: liveReadinessCheckCommand,
    rearmCandidate: stagedRearmProfile,
    handoffChecklist: [
      {
        order: 1,
        id: "review_staged_rearm_profile",
        status: allowBrokerWriteWhenAllGatesPass ? "complete" : "pending_operator_review",
        validationCommand: profileCheckCommand,
      },
      {
        order: 2,
        id: "operator_managed_active_profile_rearm",
        status: allowBrokerWriteWhenAllGatesPass ? "complete" : "pending_operator_managed_executor",
        validationCommand: profileCheckCommand,
      },
      {
        order: 3,
        id: "rerun_live_readiness",
        status: allowBrokerWriteWhenAllGatesPass ? "ready" : "blocked_until_executor_armed",
        validationCommand: liveReadinessCheckCommand,
      },
    ],
  };
  const blockers = [
    ...(profileExists ? [] : ["arm_profile:missing_active_profile"]),
    ...(schemaOk || !profileExists ? [] : ["arm_profile:schema_mismatch"]),
    ...(executorIdOk || !profileExists ? [] : ["arm_profile:executor_id_mismatch"]),
    ...(brokerTargetOk || !profileExists ? [] : ["arm_profile:broker_target_mismatch"]),
    ...(directAgentWriteDisabled || !profileExists
      ? []
      : ["arm_profile:conversation_agent_write_must_be_false"]),
    ...(killSwitchReady || !profileExists ? [] : ["arm_profile:kill_switch_not_confirmed"]),
    ...(armed && !operatorSignaturePresent ? ["arm_profile:operator_signature_missing"] : []),
    ...(armed && !armedAtOk ? ["arm_profile:armed_at_missing_or_invalid"] : []),
    ...(armed && !expiresAtOk ? ["arm_profile:expires_at_missing_or_invalid"] : []),
    ...(armed && expiresAtOk && expired ? ["arm_profile:expired"] : []),
    ...(armed && !ttlOk ? ["arm_profile:ttl_exceeds_max_900s"] : []),
    ...(armed && !allowFlag ? ["arm_profile:allow_flag_false"] : []),
  ];
  const machineLine = [
    `capitalLiveExecutorArmProfile=${status}`,
    `armed=${armed}`,
    `allowExecutorWrite=${allowBrokerWriteWhenAllGatesPass}`,
    `expired=${expired}`,
    `ttlSeconds=${ttlSeconds ?? "missing"}`,
    `killSwitch=${killSwitchReady}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "operator_managed_live_executor_arm_profile",
    executorId: EXECUTOR_ID,
    profileExists,
    profileReadStatus: profileRead.ok ? "loaded" : profileRead.error,
    armed,
    allowBrokerWriteWhenAllGatesPass,
    // @deprecated: use allowBrokerWriteWhenAllGatesPass
    allowExecutorWrite: allowBrokerWriteWhenAllGatesPass,
    allowConversationAgentDirectWrite: false,
    brokerWriteAuthorityTarget: BROKER_WRITE_TARGET,
    operatorSignaturePresent,
    armedAt: typeof profile.armedAt === "string" ? profile.armedAt : "",
    expiresAt: typeof profile.expiresAt === "string" ? profile.expiresAt : "",
    ttlSeconds,
    maxTtlSeconds: MAX_TTL_SECONDS,
    expired,
    blockers,
    requirements: {
      killSwitch: true,
      canaryRequired: true,
      rollbackRequired: true,
      freshQuoteRequired: true,
      verifiedPositionRequired: true,
      adapterAckHashRequired: true,
    },
    profileRequirementsObserved: {
      killSwitch: killSwitchReady,
      canaryRequired,
      rollbackRequired,
      freshQuoteRequired,
      verifiedPositionRequired,
      adapterAckHashRequired,
    },
    safety: {
      sentOrder: false,
      noLiveOrderSent: true,
      brokerWriteAttempted: false,
      generatedStagedRearmProfile: true,
      wroteActiveArmProfile: false,
      activeArmProfileWriteSuppressed: true,
      conversationAgentDirectBrokerWrite: false,
      reportOnly: true,
    },
    paths: {
      repoRoot: resolvedRepoRoot,
      profilePath,
      templatePath,
      stagedRearmProfilePath,
      reportPath,
      markdownPath,
    },
    template: buildTemplate(generatedAt),
    operatorReview,
    machineLine,
    nextSafeTask: allowBrokerWriteWhenAllGatesPass
      ? "Run live readiness, adapter ack, canary, rollback, and promotion gates before local executor dispatch."
      : `Fill and review .openclaw/trading/capital-live-executor-arm-profile.json, then rerun ${profileCheckCommand}.`,
  };
}

async function main() {
  const report = await buildCapitalLiveExecutorArmProfile({
    profilePath: argValue("--profile", DEFAULT_PROFILE_PATH),
    templatePath: argValue("--template", DEFAULT_TEMPLATE_PATH),
    reportPath: argValue("--output", DEFAULT_REPORT_PATH),
    markdownPath: argValue("--markdown", DEFAULT_MD_PATH),
  });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeTextWithSha(report.paths.markdownPath, buildMarkdown(report));
    await writeJsonWithSha(report.paths.templatePath, report.template);
    await writeJsonWithSha(
      report.paths.stagedRearmProfilePath,
      report.operatorReview.rearmCandidate,
    );
  }

  if (hasFlag("--check")) {
    if (report.safety.sentOrder === true || report.safety.brokerWriteAttempted === true) {
      throw new Error("CAPITAL_LIVE_EXECUTOR_ARM_PROFILE_UNSAFE_ORDER_WRITE");
    }
    if (report.status === "blocked_invalid") {
      throw new Error(
        `CAPITAL_LIVE_EXECUTOR_ARM_PROFILE_INVALID blockers=${report.blockers.join(",")}`,
      );
    }
  }

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      "OpenClaw Capital live executor arm profile",
      `status=${report.status}`,
      `armed=${report.armed}`,
      `allowExecutorWrite=${report.allowBrokerWriteWhenAllGatesPass}`,
      `sentOrder=${report.safety.sentOrder}`,
      `nextSafeTask=${report.nextSafeTask}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital live executor arm profile failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
