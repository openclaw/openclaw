#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalLiveExecutorArmProfile } from "./openclaw-capital-live-executor-arm-profile.mjs";

const SCHEMA = "openclaw.capital.live-executor-profile-rearm.v1";
const MAX_TTL_SECONDS = 900;
const DEFAULT_TTL_SECONDS = 600;
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function compactIsoStamp(iso) {
  return String(iso || "")
    .replace(/\D/g, "")
    .slice(0, 14);
}

function normalizeOperatorSlug(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "operator";
}

function buildOperatorSignature({ providedSignature, operator, nowIso }) {
  const provided = String(providedSignature || "").trim();
  if (provided.length > 0) {
    return provided;
  }
  return `operator-${normalizeOperatorSlug(operator)}-rearm-${compactIsoStamp(nowIso)}`;
}

function buildCandidateProfile({ template, operatorSignature, nowIso, expiresAtIso, reason }) {
  return {
    ...template,
    schema: "openclaw.capital.live-executor-arm-profile.v1",
    mode: "operator_managed_live_executor_arm_profile",
    armed: true,
    operatorSignature,
    armedAt: nowIso,
    expiresAt: expiresAtIso,
    maxTtlSeconds: MAX_TTL_SECONDS,
    allowBrokerWriteWhenAllGatesPass: true,
    allowConversationAgentDirectWrite: false,
    killSwitch: true,
    canaryRequired: true,
    rollbackRequired: true,
    freshQuoteRequired: true,
    verifiedPositionRequired: true,
    adapterAckHashRequired: true,
    generatedAt: nowIso,
    note: `Operator rearmed local executor profile; reason=${reason}`,
  };
}

function parseTtlSeconds(value) {
  const ttlSeconds = parsePositiveInt(value, DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    return { ok: false, ttlSeconds };
  }
  return { ok: true, ttlSeconds };
}

function pnpmCommand(root, scriptName) {
  return `pnpm --dir ${path.resolve(root)} ${scriptName}`;
}

export async function buildCapitalLiveExecutorProfileRearm(options = {}) {
  const resolvedRepoRoot = path.resolve(options.repoRoot ?? repoRoot);
  const now = options.now instanceof Date ? options.now : new Date();
  const nowIso = now.toISOString();
  const profilePath = path.resolve(
    options.profilePath ||
      path.join(resolvedRepoRoot, ".openclaw", "trading", "capital-live-executor-arm-profile.json"),
  );
  const templatePath = path.resolve(
    options.templatePath ||
      path.join(
        resolvedRepoRoot,
        ".openclaw",
        "trading",
        "templates",
        "capital-live-executor-arm-profile.template.json",
      ),
  );
  const stagedCandidatePath = path.resolve(
    options.stagedCandidatePath ||
      path.join(
        resolvedRepoRoot,
        ".openclaw",
        "trading",
        "staging",
        "capital-live-executor-arm-profile.rearm-candidate.json",
      ),
  );
  const reportPath = path.resolve(
    options.reportPath ||
      path.join(
        resolvedRepoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-live-executor-profile-rearm-latest.json",
      ),
  );
  const panelPath = path.resolve(
    options.panelPath ||
      path.join(
        resolvedRepoRoot,
        ".openclaw",
        "trading",
        "capital-live-executor-profile-rearm.json",
      ),
  );
  const operator = String(options.operator || "manual-operator").trim() || "manual-operator";
  const reason = String(options.reason || "operator-rearm").trim() || "operator-rearm";
  const execute = options.execute === true;
  const ttlParse = parseTtlSeconds(options.ttlSeconds);
  const ttlSeconds = ttlParse.ttlSeconds;
  const expiresAtIso = new Date(Date.parse(nowIso) + ttlSeconds * 1000).toISOString();
  const operatorSignature = buildOperatorSignature({
    providedSignature: options.operatorSignature,
    operator,
    nowIso,
  });
  const currentProfile = await readJsonOptional(profilePath);
  const currentProfileReport = await buildCapitalLiveExecutorArmProfile({
    repoRoot: resolvedRepoRoot,
    profilePath,
    templatePath,
  });
  const template = currentProfileReport.template ?? {};
  const candidateProfile = buildCandidateProfile({
    template,
    operatorSignature,
    nowIso,
    expiresAtIso,
    reason,
  });
  const candidateProfileSha256 = sha256Text(`${JSON.stringify(candidateProfile, null, 2)}\n`);

  const blockers = [];
  if (!ttlParse.ok) {
    blockers.push(`ttl_invalid:must_be_1_to_${MAX_TTL_SECONDS}_seconds`);
  }
  if (operatorSignature.length < 12) {
    blockers.push("operator_signature_too_short");
  }
  if (operatorSignature.includes("REPLACE_WITH")) {
    blockers.push("operator_signature_placeholder_not_allowed");
  }

  let activeProfileWritten = false;
  let profileAfter = currentProfileReport;
  if (execute && blockers.length === 0) {
    await writeJsonWithSha(profilePath, candidateProfile);
    activeProfileWritten = true;
    profileAfter = await buildCapitalLiveExecutorArmProfile({
      repoRoot: resolvedRepoRoot,
      profilePath,
      templatePath,
    });
    if (profileAfter.status !== "armed") {
      blockers.push(`post_rearm_status_not_armed:${profileAfter.status}`);
    }
  }

  const status =
    blockers.length > 0 ? "blocked" : execute ? "rearmed" : "ready_for_operator_execute";

  const profileBeforeSnapshot =
    currentProfile && typeof currentProfile === "object" ? currentProfile : null;
  const profileAfterSnapshot = activeProfileWritten ? candidateProfile : profileBeforeSnapshot;

  return {
    schema: SCHEMA,
    generatedAt: nowIso,
    status,
    mode: execute ? "live_executor_profile_rearm_execute" : "live_executor_profile_rearm_plan",
    execute,
    operator,
    reason,
    profileBeforeStatus: currentProfileReport.status,
    profileAfterStatus: profileAfter.status,
    ttlSeconds,
    maxTtlSeconds: MAX_TTL_SECONDS,
    operatorSignature,
    armedAt: nowIso,
    expiresAt: expiresAtIso,
    profileBefore: profileBeforeSnapshot,
    profileAfter: profileAfterSnapshot,
    candidateProfile,
    candidateProfileSha256,
    blockers,
    safety: {
      sentOrder: false,
      noLiveOrderSent: true,
      brokerApiCalled: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      conversationAgentDirectBrokerWrite: false,
      activeProfileWritten,
      reportOnly: !activeProfileWritten,
    },
    paths: {
      repoRoot: resolvedRepoRoot,
      profilePath,
      templatePath,
      stagedCandidatePath,
      reportPath,
      panelPath,
    },
    machineLine: [
      `capitalLiveExecutorRearm=${status}`,
      `execute=${execute}`,
      `ttlSeconds=${ttlSeconds}`,
      `profileBefore=${currentProfileReport.status}`,
      `profileAfter=${profileAfter.status}`,
      `activeProfileWritten=${activeProfileWritten}`,
      `sentOrder=false`,
      `blockers=${blockers.length}`,
    ].join(" "),
    nextSafeTask:
      status === "rearmed"
        ? [
            pnpmCommand(resolvedRepoRoot, "capital:trade:live-executor-profile:check"),
            pnpmCommand(resolvedRepoRoot, "capital:live-readiness:check"),
            pnpmCommand(resolvedRepoRoot, "capital:trade:operator-packet:check"),
          ].join(" && ")
        : status === "ready_for_operator_execute"
          ? "使用 --execute 套用 rearm candidate，並重跑 live readiness 與 operator packet gate。"
          : "修正 blocker 後重跑 capital:trade:live-executor-profile:rearm:check。",
  };
}

async function main() {
  const report = await buildCapitalLiveExecutorProfileRearm({
    repoRoot: process.cwd(),
    profilePath: argValue("--profile", ""),
    templatePath: argValue("--template", ""),
    stagedCandidatePath: argValue("--staged-candidate", ""),
    reportPath: argValue("--output", ""),
    panelPath: argValue("--panel", ""),
    operator: argValue("--operator", ""),
    operatorSignature: argValue("--operator-signature", ""),
    ttlSeconds: argValue("--ttl-seconds", String(DEFAULT_TTL_SECONDS)),
    reason: argValue("--reason", "operator-rearm"),
    execute: hasFlag("--execute"),
  });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeJsonWithSha(report.paths.stagedCandidatePath, report.candidateProfile);
  }

  if (
    hasFlag("--check") &&
    (report.safety.sentOrder === true ||
      report.safety.brokerApiCalled === true ||
      report.safety.conversationAgentDirectBrokerWrite === true)
  ) {
    throw new Error("CAPITAL_LIVE_EXECUTOR_PROFILE_REARM_UNSAFE_WRITE");
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
      `capital live executor profile rearm failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
