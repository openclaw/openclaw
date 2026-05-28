#!/usr/bin/env node

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DMAD_DIR = path.join(ROOT, ".openclaw", "dmad");
const QUEUE_DIR = path.join(DMAD_DIR, "queue");
const PENDING_DIR = path.join(QUEUE_DIR, "pending");
const IN_PROGRESS_DIR = path.join(QUEUE_DIR, "in-progress");
const COMPLETED_DIR = path.join(QUEUE_DIR, "completed");
const PATTERN_FILE = path.join(DMAD_DIR, "patterns", "dmad-pattern-registry.jsonl");
const CONFIG_FILE = path.join(DMAD_DIR, "config", "dmad-loop-config.json");

const args = process.argv.slice(2);
const blockedStateValues = new Set(["blocked", "fail", "failed", "error"]);

const fallbackConfig = {
  diagnosis: {
    defaultSource: "codex",
    defaultCategory: "live-readiness",
    defaultSeverity: "critical",
    commandTimeoutMs: 45000,
    gates: [
      {
        script: "capital:live-readiness:check",
        category: "live-readiness",
        stateFile: "reports/hermes-agent/state/openclaw-capital-live-readiness-gate-latest.json",
      },
    ],
  },
  match: {
    minConfidenceForAuto: 0.7,
  },
  execute: {
    stepTimeoutMs: 60000,
    validationTimeoutMs: 45000,
    maxOutputChars: 1200,
    postValidationCommand: `pnpm --dir "${ROOT}" capital:live-readiness:check`,
  },
  safety: {
    paperOnly: true,
    allowLiveTrading: false,
    writeBrokerOrders: false,
    sentOrder: false,
    autoExecuteRequiresApproval: false,
    denyCommandKeywords: [
      "send_future_order",
      "send_os_future_order",
      "send_stock_order",
      "live-order",
      "allowLiveTrading=true",
      "--enable-orders",
    ],
    allowCommandPrefixes: ["pnpm ", "node ", "tsx "],
  },
};

function nowIso() {
  return new Date().toISOString();
}

function trimOutput(value, maxChars = 1200) {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)} ...`;
}

function shaFingerprint(category, blocker, evidenceKey) {
  return crypto
    .createHash("sha256")
    .update(`${category}|${blocker}|${evidenceKey}`)
    .digest("hex")
    .slice(0, 16);
}

function getByPath(obj, pointer) {
  if (!obj || typeof pointer !== "string" || pointer.length === 0) {
    return undefined;
  }
  return pointer.split(".").reduce((acc, key) => {
    if (acc == null || typeof acc !== "object") {
      return undefined;
    }
    return acc[key];
  }, obj);
}

function parseMaybeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseMaybeJson(raw);
  } catch {
    return null;
  }
}

function runCommand(command, timeoutMs) {
  try {
    const stdout = execSync(command, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      encoding: "utf8",
    });
    return {
      ok: true,
      output: trimOutput(stdout),
      error: null,
      status: 0,
    };
  } catch (error) {
    const stderrText = [
      error?.stdout ? String(error.stdout) : "",
      error?.stderr ? String(error.stderr) : "",
      error?.message ? String(error.message) : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      ok: false,
      output: trimOutput(stderrText),
      error: trimOutput(stderrText),
      status: Number.isFinite(error?.status) ? error.status : 1,
    };
  }
}

function isBlockedState(state) {
  if (!state || typeof state !== "object") {
    return false;
  }
  const status = String(state.status ?? "").toLowerCase();
  const recommendation = String(state.recommendation ?? "").toLowerCase();
  if (blockedStateValues.has(status)) {
    return true;
  }
  if (recommendation === "hold" || recommendation === "blocked") {
    return true;
  }
  if (Array.isArray(state.blockers) && state.blockers.length > 0) {
    return true;
  }
  if (
    Array.isArray(state?.promotionGate?.blockedReasons) &&
    state.promotionGate.blockedReasons.length > 0
  ) {
    return true;
  }
  return false;
}

function extractBlockers(state, gateScript) {
  const blockers = new Set();
  const candidates = [
    ...(Array.isArray(state?.blockers) ? state.blockers : []),
    ...(Array.isArray(state?.promotionGate?.blockedReasons)
      ? state.promotionGate.blockedReasons
      : []),
    ...(Array.isArray(state?.validation?.blockedReasons) ? state.validation.blockedReasons : []),
  ];
  for (const candidate of candidates) {
    if (candidate == null) {
      continue;
    }
    const normalized = String(candidate).trim();
    if (normalized.length > 0) {
      blockers.add(normalized);
    }
  }
  if (blockers.size === 0 && isBlockedState(state)) {
    blockers.add(`${gateScript}:blocked`);
  }
  return [...blockers];
}

function extractEvidence(state) {
  const keyOrder = [
    "monteCarlo.p05_total_pnl_pts",
    "ack.hashOk",
    "status",
    "recommendation",
    "ready",
  ];
  for (const key of keyOrder) {
    const value = getByPath(state, key);
    if (value !== undefined) {
      return { evidenceKey: key, value };
    }
  }
  return { evidenceKey: "status", value: null };
}

function diagnosisFileName(id) {
  return `dmad-diagnosis-${id}.json`;
}

function solutionFileName(id) {
  return `dmad-solution-${id}.json`;
}

function resultFileName(id) {
  return `dmad-result-${id}.json`;
}

function normalizeSolutionSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) {
    return [];
  }
  return rawSteps.map((entry, index) => {
    if (typeof entry === "string") {
      return {
        order: index + 1,
        command: entry,
        validation: null,
        successCriteria: "exit_code_0",
        rollback: null,
        requiresApproval: false,
      };
    }
    const command = typeof entry?.command === "string" ? entry.command : "";
    return {
      order: Number.isFinite(entry?.order) ? entry.order : index + 1,
      command,
      validation: typeof entry?.validation === "string" ? entry.validation : null,
      successCriteria:
        typeof entry?.successCriteria === "string" ? entry.successCriteria : "exit_code_0",
      rollback: typeof entry?.rollback === "string" ? entry.rollback : null,
      requiresApproval: entry?.requiresApproval === true,
    };
  });
}

function commandStartsWithAllowedPrefix(command, config) {
  const allowPrefixes = Array.isArray(config?.safety?.allowCommandPrefixes)
    ? config.safety.allowCommandPrefixes
    : fallbackConfig.safety.allowCommandPrefixes;
  return allowPrefixes.some((prefix) => command.startsWith(prefix));
}

function commandContainsDeniedKeyword(command, config) {
  const denyKeywords = Array.isArray(config?.safety?.denyCommandKeywords)
    ? config.safety.denyCommandKeywords
    : fallbackConfig.safety.denyCommandKeywords;
  const lower = command.toLowerCase();
  return denyKeywords.some((keyword) => lower.includes(String(keyword).toLowerCase()));
}

function isSafeStep(step, config) {
  if (step.requiresApproval && config?.safety?.autoExecuteRequiresApproval !== true) {
    return { safe: false, reason: "requires_approval_blocked" };
  }
  const command = String(step.command ?? "").trim();
  if (command.length === 0) {
    return { safe: false, reason: "empty_command" };
  }
  if (!commandStartsWithAllowedPrefix(command, config)) {
    return { safe: false, reason: "command_prefix_not_allowed" };
  }
  if (commandContainsDeniedKeyword(command, config)) {
    return { safe: false, reason: "command_keyword_denied" };
  }
  return { safe: true, reason: null };
}

async function ensureDirs() {
  const dirs = [
    path.join(DMAD_DIR, "schemas"),
    path.join(DMAD_DIR, "patterns"),
    path.join(DMAD_DIR, "config"),
    PENDING_DIR,
    IN_PROGRESS_DIR,
    COMPLETED_DIR,
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
  try {
    await fs.access(PATTERN_FILE);
  } catch {
    await fs.writeFile(PATTERN_FILE, "", "utf8");
  }
}

async function loadConfig() {
  const loaded = await readJsonIfExists(CONFIG_FILE);
  if (!loaded || typeof loaded !== "object") {
    return fallbackConfig;
  }
  return {
    ...fallbackConfig,
    ...loaded,
    diagnosis: {
      ...fallbackConfig.diagnosis,
      ...loaded.diagnosis,
    },
    match: {
      ...fallbackConfig.match,
      ...loaded.match,
    },
    execute: {
      ...fallbackConfig.execute,
      ...loaded.execute,
    },
    safety: {
      ...fallbackConfig.safety,
      ...loaded.safety,
    },
  };
}

async function loadPatterns() {
  try {
    const raw = await fs.readFile(PATTERN_FILE, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseMaybeJson(line))
      .filter((entry) => entry && typeof entry === "object");
  } catch {
    return [];
  }
}

async function writePatterns(patterns) {
  const lines = patterns.map((entry) => JSON.stringify(entry));
  await fs.writeFile(PATTERN_FILE, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
}

async function readPendingDiagnoses() {
  const files = await fs.readdir(PENDING_DIR);
  const diagnosisFiles = files.filter((name) => name.startsWith("dmad-diagnosis-"));
  const diagnoses = [];
  for (const fileName of diagnosisFiles) {
    const fullPath = path.join(PENDING_DIR, fileName);
    const parsed = await readJsonIfExists(fullPath);
    if (parsed && typeof parsed === "object" && parsed.id) {
      diagnoses.push(parsed);
    }
  }
  return diagnoses;
}

async function diagnose(config) {
  const pending = await readPendingDiagnoses();
  const existingFingerprints = new Set(pending.map((entry) => String(entry.fingerprint ?? "")));
  const diagnoses = [];
  const gates = Array.isArray(config?.diagnosis?.gates) ? config.diagnosis.gates : [];
  for (const gate of gates) {
    const timeoutMs = Number(config?.diagnosis?.commandTimeoutMs ?? 45000);
    const commandResult = runCommand(`pnpm --dir "${ROOT}" ${gate.script}`, timeoutMs);
    const statePath = path.join(ROOT, gate.stateFile);
    const state = await readJsonIfExists(statePath);
    const stateBlocked = isBlockedState(state);
    const commandBlocked = !commandResult.ok;
    if (!stateBlocked && !commandBlocked) {
      continue;
    }

    const blockers = extractBlockers(state, gate.script);
    if (blockers.length === 0 && commandBlocked) {
      blockers.push(`${gate.script}:command_failed`);
    }
    const { evidenceKey, value } = extractEvidence(state);
    for (const blocker of blockers) {
      const category = gate.category ?? config?.diagnosis?.defaultCategory ?? "live-readiness";
      const fingerprint = shaFingerprint(category, blocker, evidenceKey);
      if (existingFingerprints.has(fingerprint)) {
        continue;
      }
      const diagnosis = {
        schema: "openclaw.dmad.diagnosis.v1",
        id: crypto.randomUUID(),
        discoveredAt: nowIso(),
        source: config?.diagnosis?.defaultSource ?? "codex",
        category,
        blocker,
        severity: config?.diagnosis?.defaultSeverity ?? "critical",
        evidence: {
          currentValue: value,
          requiredValue: "gate_pass",
          gateScript: gate.script,
          stateFile: gate.stateFile,
          errorMessage: commandResult.ok ? null : commandResult.error,
        },
        context: {
          relatedFiles: [gate.stateFile],
          relatedCommands: [`pnpm --dir "${ROOT}" ${gate.script}`],
          dependencies: [],
        },
        fingerprint,
      };
      const outputPath = path.join(PENDING_DIR, diagnosisFileName(diagnosis.id));
      await fs.writeFile(outputPath, `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
      diagnoses.push(diagnosis);
      existingFingerprints.add(fingerprint);
    }
  }
  console.log(`Diagnosed ${diagnoses.length} blockers`);
  return diagnoses;
}

function findPatternForDiagnosis(diagnosis, patterns) {
  const fingerprint = String(diagnosis?.fingerprint ?? "");
  const blocker = String(diagnosis?.blocker ?? "");
  const category = String(diagnosis?.category ?? "");
  return (
    patterns.find((entry) => String(entry?.fingerprint ?? "") === fingerprint) ??
    patterns.find(
      (entry) =>
        String(entry?.blocker ?? "") === blocker && String(entry?.category ?? "") === category,
    ) ??
    null
  );
}

function canAutoExecutePattern(diagnosis, pattern, config) {
  if (!pattern || typeof pattern !== "object") {
    return false;
  }
  const minConfidence = Number(config?.match?.minConfidenceForAuto ?? 0.7);
  const confidence = Number(pattern?.bestSolution?.confidenceFromHistory ?? 0);
  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    return false;
  }
  const steps = normalizeSolutionSteps(pattern?.bestSolution?.steps);
  if (steps.length === 0) {
    return false;
  }
  for (const step of steps) {
    const safeCheck = isSafeStep(step, config);
    if (!safeCheck.safe) {
      return false;
    }
  }
  if (commandContainsDeniedKeyword(diagnosis?.blocker ?? "", config)) {
    return false;
  }
  return true;
}

async function matchPatterns(config, diagnoses) {
  const patterns = await loadPatterns();
  const matches = diagnoses.map((diagnosis) => {
    const pattern = findPatternForDiagnosis(diagnosis, patterns);
    return {
      diagnosis,
      pattern,
      autoExecutable: canAutoExecutePattern(diagnosis, pattern, config),
    };
  });
  const autoCount = matches.filter((entry) => entry.autoExecutable).length;
  const manualCount = matches.length - autoCount;
  console.log(`Matched: ${autoCount} auto-executable, ${manualCount} need Claude analysis`);
  return { matches, patterns };
}

async function moveDiagnosisToInProgress(diagnosisId) {
  const pendingPath = path.join(PENDING_DIR, diagnosisFileName(diagnosisId));
  const progressPath = path.join(IN_PROGRESS_DIR, diagnosisFileName(diagnosisId));
  try {
    await fs.rename(pendingPath, progressPath);
    return progressPath;
  } catch {
    return progressPath;
  }
}

async function executeMatch(config, match) {
  if (!match.pattern || !match.autoExecutable) {
    return null;
  }

  const progressDiagnosisPath = await moveDiagnosisToInProgress(match.diagnosis.id);
  const solutionSteps = normalizeSolutionSteps(match.pattern?.bestSolution?.steps);
  const solutionRecord = {
    schema: "openclaw.dmad.solution.v1",
    id: crypto.randomUUID(),
    diagnosisId: match.diagnosis.id,
    createdAt: nowIso(),
    author: "openclaw-auto",
    strategy: String(match.pattern?.bestSolution?.strategy ?? "unknown"),
    confidence: Number(match.pattern?.bestSolution?.confidenceFromHistory ?? 0),
    steps: solutionSteps.map((step) => ({
      order: step.order,
      action: "shell",
      target: "repo-root",
      command: step.command,
      validation: step.validation,
      successCriteria: step.successCriteria,
      rollback: step.rollback,
      requiresApproval: step.requiresApproval,
    })),
    estimatedDuration: solutionSteps.length * 10,
    sideEffects: [],
    safety: {
      paperOnly: config?.safety?.paperOnly === true,
      writeBrokerOrders: config?.safety?.writeBrokerOrders === true,
      sentOrder: config?.safety?.sentOrder === true,
      destructive: false,
    },
  };
  await fs.writeFile(
    path.join(IN_PROGRESS_DIR, solutionFileName(solutionRecord.id)),
    `${JSON.stringify(solutionRecord, null, 2)}\n`,
    "utf8",
  );

  const result = {
    schema: "openclaw.dmad.result.v1",
    id: crypto.randomUUID(),
    solutionId: solutionRecord.id,
    diagnosisId: match.diagnosis.id,
    executedAt: nowIso(),
    executor: "openclaw-auto",
    status: "success",
    stepsCompleted: 0,
    stepsTotal: solutionSteps.length,
    stepResults: [],
    validation: {
      command: config?.execute?.postValidationCommand ?? null,
      passed: false,
      output: "",
    },
    learning: {
      patternMatch: true,
      newPattern: false,
      patternId: String(match.pattern?.patternId ?? ""),
    },
    diagnosisSnapshot: match.diagnosis,
    solutionSnapshot: solutionRecord,
  };

  const timeoutMs = Number(config?.execute?.stepTimeoutMs ?? 60000);
  for (const step of solutionSteps) {
    const safetyCheck = isSafeStep(step, config);
    if (!safetyCheck.safe) {
      result.stepResults.push({
        order: step.order,
        status: "fail",
        output: `blocked_by_safety:${safetyCheck.reason}`,
        duration: 0,
      });
      result.status = "failed";
      break;
    }

    const started = Date.now();
    const commandRun = runCommand(step.command, timeoutMs);
    const duration = Math.max(0, Math.round((Date.now() - started) / 1000));
    result.stepResults.push({
      order: step.order,
      status: commandRun.ok ? "pass" : "fail",
      output: trimOutput(commandRun.output, Number(config?.execute?.maxOutputChars ?? 1200)),
      duration,
    });
    if (!commandRun.ok) {
      result.status = "failed";
      break;
    }
    result.stepsCompleted += 1;
  }

  if (result.status !== "failed" && result.validation.command) {
    const validation = runCommand(
      result.validation.command,
      Number(config?.execute?.validationTimeoutMs ?? 45000),
    );
    result.validation.passed = validation.ok;
    result.validation.output = trimOutput(
      validation.output,
      Number(config?.execute?.maxOutputChars ?? 1200),
    );
    if (!validation.ok) {
      result.status = "partial";
    }
  } else {
    result.validation.passed = result.status === "success";
    result.validation.output = result.status === "success" ? "validation_skipped" : "step_failed";
  }

  await fs.writeFile(
    path.join(COMPLETED_DIR, resultFileName(result.id)),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  try {
    await fs.unlink(progressDiagnosisPath);
  } catch {}
  try {
    await fs.unlink(path.join(IN_PROGRESS_DIR, solutionFileName(solutionRecord.id)));
  } catch {}
  return result;
}

async function learnFromResult(result) {
  if (!result || typeof result !== "object") {
    return null;
  }
  const diagnosis = result?.diagnosisSnapshot;
  if (!diagnosis || typeof diagnosis !== "object") {
    return null;
  }
  const patterns = await loadPatterns();
  const existing = findPatternForDiagnosis(diagnosis, patterns);
  if (existing) {
    const success = result.status === "success";
    const fail = result.status === "failed";
    const best = existing.bestSolution ?? {};
    const successCount = Number(best.successCount ?? 0) + (success ? 1 : 0);
    const failCount = Number(best.failCount ?? 0) + (fail ? 1 : 0);
    existing.bestSolution = {
      ...best,
      successCount,
      failCount,
      confidenceFromHistory:
        successCount + failCount > 0 ? successCount / (successCount + failCount) : 0.5,
    };
    existing.lastMatchedAt = nowIso();
    existing.matchCount = Number(existing.matchCount ?? 0) + 1;
    await writePatterns(patterns);
    return { updated: true, patternId: existing.patternId };
  }

  const steps = normalizeSolutionSteps(result?.solutionSnapshot?.steps).map(
    (entry) => entry.command,
  );
  const newPattern = {
    patternId: crypto.randomUUID(),
    fingerprint: diagnosis.fingerprint,
    category: diagnosis.category,
    blocker: diagnosis.blocker,
    matchCriteria: {
      blockerEquals: diagnosis.blocker,
      evidenceKey: "status",
      evidenceCondition: "=== blocked",
    },
    bestSolution: {
      strategy: String(result?.solutionSnapshot?.strategy ?? "manual_from_claude"),
      steps,
      confidenceFromHistory: result.status === "success" ? 0.5 : 0.2,
      successCount: result.status === "success" ? 1 : 0,
      failCount: result.status === "failed" ? 1 : 0,
      avgDuration: null,
    },
    registeredAt: nowIso(),
    lastMatchedAt: nowIso(),
    matchCount: 1,
  };
  patterns.push(newPattern);
  await writePatterns(patterns);
  return { updated: false, patternId: newPattern.patternId };
}

async function loadResultById(resultId) {
  const byName = path.join(COMPLETED_DIR, resultFileName(resultId));
  const exact = await readJsonIfExists(byName);
  if (exact) {
    return exact;
  }
  const files = await fs.readdir(COMPLETED_DIR);
  for (const fileName of files) {
    if (!fileName.startsWith("dmad-result-")) {
      continue;
    }
    if (!fileName.includes(resultId)) {
      continue;
    }
    const parsed = await readJsonIfExists(path.join(COMPLETED_DIR, fileName));
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function findCliValue(flagName) {
  const index = args.indexOf(flagName);
  if (index < 0) {
    return null;
  }
  return args[index + 1] ?? null;
}

async function executeByDiagnosisId(config, diagnosisId) {
  const diagnoses = await readPendingDiagnoses();
  const diagnosis = diagnoses.find((entry) => String(entry.id) === diagnosisId);
  if (!diagnosis) {
    console.log(`Diagnosis ${diagnosisId} not found in pending queue`);
    return null;
  }
  const { matches } = await matchPatterns(config, [diagnosis]);
  const match = matches[0];
  if (!match) {
    return null;
  }
  if (!match.autoExecutable) {
    console.log(`[MANUAL] blocker=${diagnosis.blocker} needs Claude solution package`);
    return null;
  }
  return executeMatch(config, match);
}

function usage() {
  console.log(
    "Usage: node scripts/dmad-task-loop.mjs --diagnose | --match | --execute <diagnosisId> | --learn <resultId> | --auto",
  );
}

async function main() {
  await ensureDirs();
  const config = await loadConfig();

  if (args.includes("--diagnose")) {
    await diagnose(config);
    return;
  }

  if (args.includes("--match")) {
    const diagnoses = await readPendingDiagnoses();
    await matchPatterns(config, diagnoses);
    return;
  }

  if (args.includes("--execute")) {
    const diagnosisId = findCliValue("--execute");
    if (!diagnosisId) {
      throw new Error("missing diagnosisId for --execute");
    }
    const result = await executeByDiagnosisId(config, diagnosisId);
    if (result) {
      console.log(`Executed diagnosis=${result.diagnosisId} status=${result.status}`);
    }
    return;
  }

  if (args.includes("--learn")) {
    const resultId = findCliValue("--learn");
    if (!resultId) {
      throw new Error("missing resultId for --learn");
    }
    const result = await loadResultById(resultId);
    if (!result) {
      throw new Error(`result ${resultId} not found`);
    }
    const learn = await learnFromResult(result);
    if (learn) {
      console.log(
        `[LEARN] ${learn.updated ? "updated_existing_pattern" : "registered_new_pattern"} patternId=${learn.patternId}`,
      );
    }
    return;
  }

  if (args.includes("--auto")) {
    const diagnoses = await diagnose(config);
    if (diagnoses.length === 0) {
      console.log("No blockers found. System healthy.");
      return;
    }
    const { matches } = await matchPatterns(config, diagnoses);
    for (const match of matches) {
      if (!match.autoExecutable) {
        console.log(`[MANUAL] blocker=${match.diagnosis.blocker} needs Claude solution package`);
        continue;
      }
      const result = await executeMatch(config, match);
      if (result) {
        await learnFromResult(result);
      }
    }
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
