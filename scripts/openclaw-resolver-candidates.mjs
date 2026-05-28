#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_WATCH_REGISTRY_REPORT_REL } from "./openclaw-source-watch-registry.mjs";

export const RESOLVER_CANDIDATES_SCHEMA = "openclaw.resolver-candidates.v1";
export const RESOLVER_CANDIDATES_REPORT_REL = "reports/openclaw-resolver-candidates-latest.json";

const LOCAL_SOURCE_GAP_REPORT_REL = "reports/openclaw-execution-automation-source-gap-checklist.md";
const WEAK_SIGNAL_INTAKE_GATE_REPORT_REL = "reports/openclaw-weak-signal-intake-gate-latest.json";

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function buildCandidate(generatedAt, sourceRegistry) {
  const sourceSummary = sourceRegistry?.summary ?? {};
  return {
    id: "controlled-runner-resolver-candidate-routing",
    status: "ready_for_review",
    priority: "P1",
    blocker: {
      id: "resolution-executor-not-wired",
      summary:
        "Controlled runner has next_safe_task and fallbacks, but confirmed blockers are not yet represented as reviewable resolver candidates.",
      observedIn: [
        LOCAL_SOURCE_GAP_REPORT_REL,
        SOURCE_WATCH_REGISTRY_REPORT_REL,
        "scripts/openclaw-controlled-task-runner.mjs",
      ],
    },
    sourceEvidence: [
      {
        sourceId: "local-source-gap-checklist",
        sourceType: "local_report",
        trustLevel: "high",
        path: LOCAL_SOURCE_GAP_REPORT_REL,
        evidence: "Checklist item 4 requires resolver-candidate schema before runner wiring.",
      },
      {
        sourceId: "source-watch-registry",
        sourceType: "local_report",
        trustLevel: "high",
        path: SOURCE_WATCH_REGISTRY_REPORT_REL,
        evidence: `Source registry classifies ${sourceSummary.totalSources ?? 0} sources and exposes resolverCandidateSources=${sourceSummary.resolverCandidateSources ?? 0}.`,
      },
    ],
    risk: {
      level: "P1",
      runtimeMutationAllowed: false,
      externalWriteAllowed: false,
      liveTradingAllowed: false,
      requiresHumanReviewBeforeApply: true,
    },
    proposedCommand: {
      mode: "planned_only",
      command: "pnpm autonomous:resolver-candidates:check",
      allowlisted: true,
      autoExecute: false,
      reason:
        "First validate the resolver candidate schema and evidence shape; runtime wiring remains a separate task.",
    },
    sameCaseRerun: {
      required: true,
      commands: [
        "pnpm autonomous:resolver-candidates:check",
        "pnpm check:openclaw-controlled-task-runner",
      ],
      evidencePath: RESOLVER_CANDIDATES_REPORT_REL,
    },
    rollbackPath: [
      "Remove-Item -LiteralPath scripts/openclaw-resolver-candidates.mjs",
      "Remove-Item -LiteralPath scripts/check-openclaw-resolver-candidates.mjs",
      "Remove-Item -LiteralPath reports/openclaw-resolver-candidates-latest.json",
      "Remove package.json scripts autonomous:resolver-candidates, autonomous:resolver-candidates:check, and check:openclaw-resolver-candidates",
    ],
    generatedAt,
  };
}

function buildSameCaseEvidenceLockCandidate(generatedAt, sourceRegistry) {
  const sourceSummary = sourceRegistry?.summary ?? {};
  return {
    id: "same-case-rerun-evidence-lock",
    status: "ready_for_review",
    priority: "P1",
    blocker: {
      id: "promotion-evidence-not-locked",
      summary:
        "Resolver candidates need same-case rerun evidence before any staged promotion or rollback decision.",
      observedIn: [
        LOCAL_SOURCE_GAP_REPORT_REL,
        SOURCE_WATCH_REGISTRY_REPORT_REL,
        "scripts/openclaw-controlled-task-runner.mjs",
      ],
    },
    sourceEvidence: [
      {
        sourceId: "local-source-gap-checklist",
        sourceType: "local_report",
        trustLevel: "high",
        path: LOCAL_SOURCE_GAP_REPORT_REL,
        evidence: "Checklist item 6 requires same-case rerun evidence before promotion.",
      },
      {
        sourceId: "source-watch-registry",
        sourceType: "local_report",
        trustLevel: "high",
        path: SOURCE_WATCH_REGISTRY_REPORT_REL,
        evidence: `Source registry requires trusted resolver candidates before evidence promotion; trustedSourceCount=${sourceSummary.trustedSourceCount ?? 0}.`,
      },
    ],
    risk: {
      level: "P1",
      runtimeMutationAllowed: false,
      externalWriteAllowed: false,
      liveTradingAllowed: false,
      requiresHumanReviewBeforeApply: true,
    },
    proposedCommand: {
      mode: "planned_only",
      command: "pnpm check:openclaw-controlled-task-runner",
      allowlisted: true,
      autoExecute: false,
      reason:
        "First validate runner resolver metadata, then record same-case rerun evidence in a separate task.",
    },
    sameCaseRerun: {
      required: true,
      commands: [
        "pnpm check:openclaw-controlled-task-runner",
        "pnpm test test/scripts/openclaw-controlled-task-runner.next-safe-card-routing.test.ts",
      ],
      evidencePath:
        "reports/hermes-agent/state/openclaw-controlled-task-runner-evidence-lock-latest.json",
    },
    rollbackPath: [
      "git checkout -- scripts/openclaw-controlled-task-runner.mjs",
      "git checkout -- scripts/check-openclaw-controlled-task-runner.mjs",
      "git checkout -- test/scripts/openclaw-controlled-task-runner.next-safe-card-routing.test.ts",
    ],
    generatedAt,
  };
}

function buildWeakSignalIntakeCandidate(generatedAt, sourceRegistry) {
  const sourceSummary = sourceRegistry?.summary ?? {};
  return {
    id: "weak-signal-intake-gate",
    status: "completed",
    priority: "P1",
    blocker: {
      id: "weak-signal-intake-not-gated",
      summary:
        "Discussion and community sources need a needs-confirmation gate before they can become resolver candidates.",
      observedIn: [LOCAL_SOURCE_GAP_REPORT_REL, SOURCE_WATCH_REGISTRY_REPORT_REL],
    },
    sourceEvidence: [
      {
        sourceId: "local-source-gap-checklist",
        sourceType: "local_report",
        trustLevel: "high",
        path: LOCAL_SOURCE_GAP_REPORT_REL,
        evidence: "Checklist item 7 requires weak-signal intake to stay needs-confirmation only.",
      },
      {
        sourceId: "source-watch-registry",
        sourceType: "local_report",
        trustLevel: "high",
        path: SOURCE_WATCH_REGISTRY_REPORT_REL,
        evidence: `Source registry currently tracks needsConfirmationSources=${sourceSummary.needsConfirmationSources ?? 0}.`,
      },
    ],
    risk: {
      level: "P1",
      runtimeMutationAllowed: false,
      externalWriteAllowed: false,
      liveTradingAllowed: false,
      requiresHumanReviewBeforeApply: true,
    },
    proposedCommand: {
      mode: "planned_only",
      command: "pnpm autonomous:source-watch:registry:check",
      allowlisted: true,
      autoExecute: false,
      reason:
        "First prove weak sources stay needs-confirmation before any intake maps them to local tasks.",
    },
    sameCaseRerun: {
      required: true,
      commands: [
        "pnpm autonomous:weak-signal-intake-gate:check",
        "pnpm autonomous:resolver-candidates:check",
      ],
      evidencePath: WEAK_SIGNAL_INTAKE_GATE_REPORT_REL,
    },
    rollbackPath: [
      "git checkout -- scripts/openclaw-source-watch-registry.mjs",
      "git checkout -- scripts/check-openclaw-source-watch-registry.mjs",
      "git checkout -- reports/openclaw-source-watch-registry-latest.json",
    ],
    generatedAt,
  };
}

function buildCronWatchSourceCheckCandidate(generatedAt) {
  return {
    id: "cron-watch-source-check",
    status: "ready_for_review",
    priority: "P1",
    blocker: {
      id: "source-watch-not-scheduled-dry-run",
      summary:
        "Source watch has a registry and weak-signal gate, but it is not yet represented as a dry-run scheduled check.",
      observedIn: [
        LOCAL_SOURCE_GAP_REPORT_REL,
        SOURCE_WATCH_REGISTRY_REPORT_REL,
        WEAK_SIGNAL_INTAKE_GATE_REPORT_REL,
      ],
    },
    sourceEvidence: [
      {
        sourceId: "local-source-gap-checklist",
        sourceType: "local_report",
        trustLevel: "high",
        path: LOCAL_SOURCE_GAP_REPORT_REL,
        evidence: "Checklist item 9 requires cron/watch source checks to stay dry-run first.",
      },
      {
        sourceId: "weak-signal-intake-gate",
        sourceType: "local_report",
        trustLevel: "high",
        path: WEAK_SIGNAL_INTAKE_GATE_REPORT_REL,
        evidence:
          "Weak-signal gate must pass before scheduled source checks can ingest community sources.",
      },
    ],
    risk: {
      level: "P1",
      runtimeMutationAllowed: false,
      externalWriteAllowed: false,
      liveTradingAllowed: false,
      requiresHumanReviewBeforeApply: true,
    },
    proposedCommand: {
      mode: "planned_only",
      command: "pnpm autonomous:weak-signal-intake-gate:check",
      allowlisted: true,
      autoExecute: false,
      reason:
        "First prove weak signals are locked, then add a dry-run scheduler/watch surface as a separate task.",
    },
    sameCaseRerun: {
      required: true,
      commands: [
        "pnpm autonomous:weak-signal-intake-gate:check",
        "pnpm autonomous:source-watch:registry:check",
      ],
      evidencePath: "reports/openclaw-source-watch-cron-check-latest.json",
    },
    rollbackPath: [
      "Remove-Item -LiteralPath scripts/openclaw-source-watch-cron-check.mjs",
      "Remove-Item -LiteralPath scripts/check-openclaw-source-watch-cron-check.mjs",
      "Remove-Item -LiteralPath reports/openclaw-source-watch-cron-check-latest.json",
    ],
    generatedAt,
  };
}

export async function buildResolverCandidatesReport(repoRoot = process.cwd(), options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sourceRegistry = await readJsonIfExists(
    path.join(repoRoot, SOURCE_WATCH_REGISTRY_REPORT_REL),
  );
  const candidates = [
    buildCandidate(generatedAt, sourceRegistry),
    buildSameCaseEvidenceLockCandidate(generatedAt, sourceRegistry),
    buildWeakSignalIntakeCandidate(generatedAt, sourceRegistry),
    buildCronWatchSourceCheckCandidate(generatedAt),
  ];
  return {
    schema: RESOLVER_CANDIDATES_SCHEMA,
    generatedAt,
    mode: "dry_run",
    safety: {
      dryRunOnly: true,
      runtimeMutationAllowed: false,
      externalWriteAllowed: false,
      autoExecuteAllowed: false,
      liveTradingAllowed: false,
    },
    summary: {
      totalCandidates: candidates.length,
      readyForReview: candidates.filter((candidate) => candidate.status === "ready_for_review")
        .length,
      completed: candidates.filter((candidate) => candidate.status === "completed").length,
      autoExecutable: candidates.filter((candidate) => candidate.proposedCommand.autoExecute)
        .length,
      sourceRegistryPresent: sourceRegistry !== null,
    },
    candidates,
    nextSafeTask: {
      id: "cron-watch-source-check",
      command: "create dry-run first source watch scheduler/check",
      reason: "weak-signal intake is now gated; next step is dry-run source watch scheduling.",
    },
  };
}

export async function writeResolverCandidatesReport(repoRoot = process.cwd(), options = {}) {
  const outputRel = options.outputRel ?? RESOLVER_CANDIDATES_REPORT_REL;
  const outputPath = path.join(repoRoot, outputRel);
  const report = await buildResolverCandidatesReport(repoRoot, options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { outputRel, report };
}

async function main() {
  const { outputRel, report } = await writeResolverCandidatesReport(process.cwd());
  process.stdout.write(
    [
      "OPENCLAW_RESOLVER_CANDIDATES=OK",
      `path=${outputRel}`,
      `candidates=${report.summary.totalCandidates}`,
      `mode=${report.mode}`,
      `next=${report.nextSafeTask.id}`,
    ].join(" ") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `OPENCLAW_RESOLVER_CANDIDATES=FAIL ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
