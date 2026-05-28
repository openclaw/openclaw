#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_WATCH_REGISTRY_REPORT_REL } from "./openclaw-source-watch-registry.mjs";

export const WEAK_SIGNAL_INTAKE_GATE_SCHEMA = "openclaw.weak-signal-intake-gate.v1";
export const WEAK_SIGNAL_INTAKE_GATE_REPORT_REL =
  "reports/openclaw-weak-signal-intake-gate-latest.json";

const WEAK_SIGNAL_SOURCE_TYPES = new Set([
  "github_discussions",
  "reddit_public",
  "third_party_discovery",
]);

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

function isWeakSignalSource(source) {
  return (
    source?.candidateOutput === "needs_confirmation" ||
    source?.trustLevel !== "high" ||
    WEAK_SIGNAL_SOURCE_TYPES.has(source?.sourceType)
  );
}

function buildWeakSignalRule(source) {
  const unsafeReasons = [];
  if (source.candidateOutput !== "needs_confirmation") {
    unsafeReasons.push("candidateOutput_not_needs_confirmation");
  }
  if (source.autoResolverAllowed !== false) {
    unsafeReasons.push("autoResolverAllowed_not_false");
  }
  if (source.externalWriteAllowed !== false) {
    unsafeReasons.push("externalWriteAllowed_not_false");
  }
  if (source.evidenceRules?.allowRuntimePatchWithoutLocalValidation !== false) {
    unsafeReasons.push("runtime_patch_without_local_validation_not_false");
  }

  return {
    sourceId: source.id,
    sourceType: source.sourceType,
    trustLevel: source.trustLevel,
    candidateOutput: source.candidateOutput,
    intakePolicy: source.intakePolicy,
    requiresConfirmation: source.requiresConfirmation === true,
    autoResolverAllowed: source.autoResolverAllowed === true,
    runtimePatchAllowed: source.evidenceRules?.allowRuntimePatchWithoutLocalValidation === true,
    decision: unsafeReasons.length === 0 ? "needs_confirmation_locked" : "blocked_unsafe_promotion",
    unsafeReasons,
  };
}

export async function buildWeakSignalIntakeGateReport(repoRoot = process.cwd(), options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sourceRegistry = await readJsonIfExists(
    path.join(repoRoot, SOURCE_WATCH_REGISTRY_REPORT_REL),
  );
  const sources = Array.isArray(sourceRegistry?.sources) ? sourceRegistry.sources : [];
  const weakSignals = sources
    .filter((source) => isWeakSignalSource(source))
    .map(buildWeakSignalRule);
  const confirmedResolverSources = sources
    .filter(
      (source) =>
        source.candidateOutput === "resolver_candidate" &&
        !isWeakSignalSource(source) &&
        source.autoResolverAllowed === false,
    )
    .map((source) => ({
      sourceId: source.id,
      sourceType: source.sourceType,
      trustLevel: source.trustLevel,
      candidateOutput: source.candidateOutput,
      requiresConfirmation: source.requiresConfirmation === true,
      rule: "source_or_local_repro_required_before_resolution",
    }));
  const unsafeWeakPromotions = weakSignals.filter(
    (source) => source.decision !== "needs_confirmation_locked",
  );
  const pass =
    sourceRegistry !== null && weakSignals.length >= 1 && unsafeWeakPromotions.length === 0;

  return {
    schema: WEAK_SIGNAL_INTAKE_GATE_SCHEMA,
    generatedAt,
    mode: "dry_run",
    status: pass ? "pass_needs_confirmation_locked" : "blocked_unsafe_weak_signal",
    sourceRegistryPath: SOURCE_WATCH_REGISTRY_REPORT_REL,
    reportPath: WEAK_SIGNAL_INTAKE_GATE_REPORT_REL,
    safety: {
      dryRunOnly: true,
      runtimeMutationAllowed: false,
      externalWriteAllowed: false,
      autoExecuteAllowed: false,
      liveTradingAllowed: false,
      networkFetchPerformed: false,
      loginAttempted: false,
    },
    rules: {
      weakSignalCandidateOutput: "needs_confirmation",
      allowWeakSignalResolverCandidate: false,
      allowWeakSignalRuntimePatch: false,
      requireTrustedSourceOrLocalReproBeforeResolverCandidate: true,
    },
    summary: {
      totalSources: sources.length,
      weakSignals: weakSignals.length,
      confirmedResolverSources: confirmedResolverSources.length,
      needsConfirmationCount: weakSignals.filter(
        (source) => source.candidateOutput === "needs_confirmation",
      ).length,
      unsafeWeakPromotions: unsafeWeakPromotions.length,
      promotionAllowed: false,
      sourceRegistryPresent: sourceRegistry !== null,
    },
    weakSignals,
    confirmedResolverSources,
    blockedPromotions: weakSignals.map((source) => ({
      sourceId: source.sourceId,
      reason:
        "weak signal requires official source evidence or local reproduction before resolver promotion",
      blockedOutputs: ["resolver_candidate", "runtime_patch", "auto_execute"],
    })),
    nextSafeTask: {
      id: "cron-watch-source-check",
      command: "create dry-run first source watch scheduler/check",
      reason:
        "weak signals are now locked behind needs-confirmation; next step is a scheduled dry-run source watch without login or external writes.",
    },
    rollbackPath: [
      "Remove-Item -LiteralPath scripts/openclaw-weak-signal-intake-gate.mjs",
      "Remove-Item -LiteralPath scripts/check-openclaw-weak-signal-intake-gate.mjs",
      "Remove-Item -LiteralPath reports/openclaw-weak-signal-intake-gate-latest.json",
      "Remove package.json scripts autonomous:weak-signal-intake-gate, autonomous:weak-signal-intake-gate:check, and check:openclaw-weak-signal-intake-gate",
    ],
  };
}

export async function writeWeakSignalIntakeGateReport(repoRoot = process.cwd(), options = {}) {
  const outputRel = options.outputRel ?? WEAK_SIGNAL_INTAKE_GATE_REPORT_REL;
  const outputPath = path.join(repoRoot, outputRel);
  const report = await buildWeakSignalIntakeGateReport(repoRoot, options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { outputRel, report };
}

async function main() {
  const { outputRel, report } = await writeWeakSignalIntakeGateReport(process.cwd());
  process.stdout.write(
    [
      "OPENCLAW_WEAK_SIGNAL_INTAKE_GATE=OK",
      `path=${outputRel}`,
      `status=${report.status}`,
      `weak=${report.summary.weakSignals}`,
      `unsafe=${report.summary.unsafeWeakPromotions}`,
      `next=${report.nextSafeTask.id}`,
    ].join(" ") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `OPENCLAW_WEAK_SIGNAL_INTAKE_GATE=FAIL ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
