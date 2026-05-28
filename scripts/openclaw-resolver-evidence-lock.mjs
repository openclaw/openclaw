#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESOLVER_CANDIDATES_REPORT_REL } from "./openclaw-resolver-candidates.mjs";

export const RESOLVER_EVIDENCE_LOCK_SCHEMA = "openclaw.resolver-evidence-lock.v1";
export const RESOLVER_EVIDENCE_LOCK_REPORT_REL =
  "reports/hermes-agent/state/openclaw-controlled-task-runner-evidence-lock-latest.json";

const DEFAULT_CANDIDATE_ID = "same-case-rerun-evidence-lock";
const ALLOWED_RERUN_COMMANDS = new Set([
  "pnpm autonomous:resolver-candidates:check",
  "pnpm check:openclaw-controlled-task-runner",
  "pnpm test test/scripts/openclaw-controlled-task-runner.next-safe-card-routing.test.ts",
]);

function parseArgs(argv) {
  const options = {
    candidateId: DEFAULT_CANDIDATE_ID,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--candidate requires a value");
      }
      options.candidateId = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function limitText(value, maxLength = 4000) {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : text.slice(text.length - maxLength);
}

function resolveCommand(command) {
  if (process.platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    file: "sh",
    args: ["-lc", command],
  };
}

function runCommand(repoRoot, command) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const resolved = resolveCommand(command);
    const child = spawn(resolved.file, resolved.args, {
      cwd: repoRoot,
      env: { ...process.env, CI: process.env.CI ?? "1" },
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];

    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      resolve({
        command,
        allowed: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode: null,
        errorCode: error.code ?? "SPAWN_ERROR",
        stdoutTail: limitText(Buffer.concat(stdout).toString("utf8")),
        stderrTail: limitText(Buffer.concat(stderr).toString("utf8") || error.message),
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        command,
        allowed: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode,
        errorCode: exitCode === 0 ? "OK" : "COMMAND_FAILED",
        stdoutTail: limitText(Buffer.concat(stdout).toString("utf8")),
        stderrTail: limitText(Buffer.concat(stderr).toString("utf8")),
      });
    });
  });
}

function findCandidate(report, candidateId) {
  const candidates = Array.isArray(report?.candidates) ? report.candidates : [];
  return candidates.find((candidate) => normalizeText(candidate?.id) === candidateId) ?? null;
}

function collectOpenP0P1Candidates(report) {
  const candidates = Array.isArray(report?.candidates) ? report.candidates : [];
  return candidates
    .filter((candidate) => ["P0", "P1"].includes(normalizeText(candidate?.priority)))
    .filter(
      (candidate) =>
        !["completed", "closed", "promoted"].includes(normalizeText(candidate?.status)),
    )
    .map((candidate) => ({
      id: normalizeText(candidate.id),
      priority: normalizeText(candidate.priority),
      status: normalizeText(candidate.status),
      blockerId: normalizeText(candidate.blocker?.id),
    }));
}

function validateSafety(candidate, report) {
  const failures = [];
  if (report?.mode !== "dry_run") {
    failures.push("resolver candidates report must stay dry_run");
  }
  if (report?.safety?.runtimeMutationAllowed !== false) {
    failures.push("runtime mutation must be disabled");
  }
  if (report?.safety?.externalWriteAllowed !== false) {
    failures.push("external writes must be disabled");
  }
  if (report?.safety?.autoExecuteAllowed !== false) {
    failures.push("auto execute must be disabled");
  }
  if (report?.safety?.liveTradingAllowed !== false) {
    failures.push("live trading must be disabled");
  }
  if (candidate?.risk?.runtimeMutationAllowed !== false) {
    failures.push("candidate runtime mutation must be false");
  }
  if (candidate?.risk?.externalWriteAllowed !== false) {
    failures.push("candidate external write must be false");
  }
  if (candidate?.risk?.liveTradingAllowed !== false) {
    failures.push("candidate live trading must be false");
  }
  if (candidate?.proposedCommand?.mode !== "planned_only") {
    failures.push("candidate command must be planned_only");
  }
  if (candidate?.proposedCommand?.autoExecute !== false) {
    failures.push("candidate autoExecute must be false");
  }
  return failures;
}

export async function buildResolverEvidenceLock(repoRoot = process.cwd(), options = {}) {
  const generatedAt = new Date().toISOString();
  const candidateId = options.candidateId ?? DEFAULT_CANDIDATE_ID;
  const report = await readJson(path.join(repoRoot, RESOLVER_CANDIDATES_REPORT_REL));
  const candidate = findCandidate(report, candidateId);
  const base = {
    schema: RESOLVER_EVIDENCE_LOCK_SCHEMA,
    generatedAt,
    mode: "same_case_rerun_evidence_lock",
    sourceReportPath: RESOLVER_CANDIDATES_REPORT_REL,
    reportPath: RESOLVER_EVIDENCE_LOCK_REPORT_REL,
    candidateId,
  };

  if (!candidate) {
    return {
      ...base,
      status: "blocked_candidate_missing",
      errorCode: "CANDIDATE_MISSING",
      commands: [],
      safetyFailures: [],
      summary: {
        totalCommands: 0,
        passedCommands: 0,
        failedCommands: 0,
        blockedCommands: 0,
        evidenceComplete: false,
        promotionAllowed: false,
      },
      promotionGate: {
        status: "blocked_candidate_missing",
        openP0P1Candidates: collectOpenP0P1Candidates(report),
      },
    };
  }

  const safetyFailures = validateSafety(candidate, report);
  const rawCommands = Array.isArray(candidate.sameCaseRerun?.commands)
    ? candidate.sameCaseRerun.commands.map((command) => normalizeText(command)).filter(Boolean)
    : [];
  const blockedCommands = rawCommands
    .filter((command) => !ALLOWED_RERUN_COMMANDS.has(command))
    .map((command) => ({
      command,
      allowed: false,
      exitCode: null,
      errorCode: "COMMAND_NOT_ALLOWLISTED",
    }));
  const runnableCommands =
    safetyFailures.length === 0
      ? rawCommands.filter((command) => ALLOWED_RERUN_COMMANDS.has(command))
      : [];

  const commandResults = [];
  for (const command of runnableCommands) {
    commandResults.push(await runCommand(repoRoot, command));
  }
  const commands = [...commandResults, ...blockedCommands];
  const passedCommands = commandResults.filter((result) => result.exitCode === 0).length;
  const failedCommands = commandResults.filter((result) => result.exitCode !== 0).length;
  const openP0P1Candidates = collectOpenP0P1Candidates(report);
  const evidenceComplete =
    safetyFailures.length === 0 &&
    blockedCommands.length === 0 &&
    rawCommands.length > 0 &&
    passedCommands === rawCommands.length;
  const promotionAllowed = evidenceComplete && openP0P1Candidates.length === 0;
  const promotionStatus = promotionAllowed
    ? "promotion_allowed"
    : evidenceComplete
      ? "blocked_p0_p1_open"
      : "blocked_evidence_incomplete";

  return {
    ...base,
    status: evidenceComplete ? "evidence_locked" : "blocked_evidence_incomplete",
    errorCode: evidenceComplete ? "OK" : "EVIDENCE_INCOMPLETE",
    candidate: {
      id: normalizeText(candidate.id),
      status: normalizeText(candidate.status),
      priority: normalizeText(candidate.priority),
      blockerId: normalizeText(candidate.blocker?.id),
      plannedOnly: candidate.proposedCommand?.mode === "planned_only",
      autoExecute: candidate.proposedCommand?.autoExecute === true,
      evidencePath: normalizeText(candidate.sameCaseRerun?.evidencePath),
    },
    safety: {
      dryRunOnly: report?.safety?.dryRunOnly === true,
      runtimeMutationAllowed: report?.safety?.runtimeMutationAllowed === true,
      externalWriteAllowed: report?.safety?.externalWriteAllowed === true,
      autoExecuteAllowed: report?.safety?.autoExecuteAllowed === true,
      liveTradingAllowed: report?.safety?.liveTradingAllowed === true,
    },
    safetyFailures,
    commands,
    summary: {
      totalCommands: rawCommands.length,
      passedCommands,
      failedCommands,
      blockedCommands: blockedCommands.length,
      evidenceComplete,
      promotionAllowed,
    },
    promotionGate: {
      status: promotionStatus,
      reason: promotionAllowed
        ? "same-case rerun evidence is complete and no P0/P1 candidates remain"
        : evidenceComplete
          ? "same-case rerun evidence is complete, but P0/P1 candidates remain open"
          : "same-case rerun evidence is incomplete",
      openP0P1Candidates,
    },
    rollbackPath: Array.isArray(candidate.rollbackPath) ? candidate.rollbackPath : [],
    nextSafeTask: promotionAllowed
      ? {
          id: "weak-signal-intake-gate",
          command: "pnpm autonomous:source-watch:registry:check",
          reason: "evidence lock passed; continue to weak-signal intake gate",
        }
      : {
          id: "weak-signal-intake-gate",
          command: "pnpm autonomous:source-watch:registry:check",
          reason: "evidence lock passed but promotion remains blocked by open P0/P1 candidates",
        },
  };
}

export async function writeResolverEvidenceLock(repoRoot = process.cwd(), options = {}) {
  const outputRel = options.outputRel ?? RESOLVER_EVIDENCE_LOCK_REPORT_REL;
  const outputPath = path.join(repoRoot, outputRel);
  const report = await buildResolverEvidenceLock(repoRoot, options);
  await writeJson(outputPath, report);
  return { outputRel, report };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { outputRel, report } = await writeResolverEvidenceLock(process.cwd(), options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `OPENCLAW_RESOLVER_EVIDENCE_LOCK=${report.errorCode === "OK" ? "OK" : "FAIL"}`,
        `path=${outputRel}`,
        `candidate=${report.candidateId}`,
        `evidence=${report.summary.evidenceComplete ? "pass" : "fail"}`,
        `promotion=${report.promotionGate.status}`,
      ].join(" ") + "\n",
    );
  }
  if (report.errorCode !== "OK") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `OPENCLAW_RESOLVER_EVIDENCE_LOCK=FAIL ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
