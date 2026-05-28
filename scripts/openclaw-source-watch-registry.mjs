#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_WATCH_REGISTRY_SCHEMA = "openclaw.source-watch-registry.v1";
export const SOURCE_WATCH_REGISTRY_REPORT_REL =
  "reports/openclaw-source-watch-registry-latest.json";

const SOURCE_DEFINITIONS = [
  {
    id: "official-openclaw-site",
    sourceType: "official_site",
    trustLevel: "high",
    url: "https://openclaw.ai/",
    purpose: "official install, docs entrypoint, source checkout, product capability claims",
    intakePolicy: "authoritative_reference",
    candidateOutput: "source_evidence",
    autoResolverAllowed: false,
    requiresConfirmation: false,
  },
  {
    id: "github-openclaw-org",
    sourceType: "github_org",
    trustLevel: "high",
    url: "https://github.com/openclaw",
    purpose: "official repository, ClawHub repository, organization-level source map",
    intakePolicy: "authoritative_reference",
    candidateOutput: "source_evidence",
    autoResolverAllowed: false,
    requiresConfirmation: false,
  },
  {
    id: "github-openclaw-issues",
    sourceType: "github_issues",
    trustLevel: "high",
    url: "https://github.com/openclaw/openclaw/issues",
    purpose: "bug reports, ClawSweeper labels, source-backed repair candidates",
    intakePolicy: "resolver_candidate_requires_source_repro",
    candidateOutput: "resolver_candidate",
    autoResolverAllowed: false,
    requiresConfirmation: true,
  },
  {
    id: "github-openclaw-discussions",
    sourceType: "github_discussions",
    trustLevel: "medium",
    url: "https://github.com/openclaw/openclaw/discussions",
    purpose: "announcements, ideas, Q&A, show-and-tell signals",
    intakePolicy: "needs_confirmation_before_runtime_change",
    candidateOutput: "needs_confirmation",
    autoResolverAllowed: false,
    requiresConfirmation: true,
  },
  {
    id: "reddit-openclaw",
    sourceType: "reddit_public",
    trustLevel: "low",
    url: "https://www.reddit.com/r/openclaw/",
    purpose: "public user pain points and community usage signals",
    intakePolicy: "weak_signal_only",
    candidateOutput: "needs_confirmation",
    autoResolverAllowed: false,
    requiresConfirmation: true,
  },
  {
    id: "third-party-openclaw-sites",
    sourceType: "third_party_discovery",
    trustLevel: "low",
    url: null,
    purpose: "marketing pages, unofficial tutorials, possible community entrypoints",
    intakePolicy: "discovery_only",
    candidateOutput: "needs_confirmation",
    autoResolverAllowed: false,
    requiresConfirmation: true,
  },
];

function toDedupeKey(source) {
  return [source.sourceType, source.url ?? source.id].join(":");
}

function buildSourceEntry(source, timestamp) {
  return {
    ...source,
    publicAccessOnly: true,
    loginRequired: false,
    externalWriteAllowed: false,
    privateGroupAllowed: false,
    dedupeKey: toDedupeKey(source),
    lastCheckedAt: timestamp,
    evidenceRules: {
      requireOfficialOrLocalRepro:
        source.trustLevel !== "high" || source.sourceType === "github_issues",
      allowRuntimePatchWithoutLocalValidation: false,
      allowInstallFromSource:
        source.sourceType === "official_site" || source.sourceType === "github_org",
    },
  };
}

export function buildSourceWatchRegistryReport(options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sources = SOURCE_DEFINITIONS.map((source) => buildSourceEntry(source, generatedAt));
  const trustedSourceCount = sources.filter((source) => source.trustLevel === "high").length;
  const weakSignalCount = sources.filter((source) => source.trustLevel === "low").length;

  return {
    schema: SOURCE_WATCH_REGISTRY_SCHEMA,
    generatedAt,
    mode: "dry_run",
    safety: {
      dryRunOnly: true,
      networkFetchPerformed: false,
      externalWriteAllowed: false,
      loginAttempted: false,
      privateGroupAccessAllowed: false,
      runtimeMutationAllowed: false,
    },
    summary: {
      totalSources: sources.length,
      trustedSourceCount,
      weakSignalCount,
      resolverCandidateSources: sources.filter(
        (source) => source.candidateOutput === "resolver_candidate",
      ).length,
      needsConfirmationSources: sources.filter(
        (source) => source.candidateOutput === "needs_confirmation",
      ).length,
    },
    sources,
    requiredNextArtifacts: [
      {
        id: "resolver-candidate-schema",
        status: "completed",
        purpose:
          "Convert confirmed blockers into reviewable repair candidates with source evidence, risk, command, same-case rerun, and rollback path.",
      },
      {
        id: "same-case-rerun-evidence-lock",
        status: "completed",
        purpose:
          "Require the exact failed case to pass again before a resolver candidate can be promoted.",
      },
      {
        id: "weak-signal-intake-gate",
        status: "completed",
        purpose:
          "Keep discussion and community sources as needs-confirmation signals until a trusted source or local repro exists.",
      },
      {
        id: "cron-watch-source-check",
        status: "pending",
        purpose:
          "Run the source watch as a dry-run scheduled check without login, external writes, or runtime mutation.",
      },
    ],
    nextSafeTask: {
      id: "cron-watch-source-check",
      command: "create dry-run first source watch scheduler/check",
      reason: "weak-signal intake is now gated; next step is a dry-run scheduler/watch check.",
    },
    rollbackPath: [
      "Remove-Item -LiteralPath scripts/openclaw-source-watch-registry.mjs",
      "Remove-Item -LiteralPath scripts/check-openclaw-source-watch-registry.mjs",
      "Remove-Item -LiteralPath reports/openclaw-source-watch-registry-latest.json",
      "Remove package.json scripts autonomous:source-watch:registry, autonomous:source-watch:registry:check, and check:openclaw-source-watch-registry",
    ],
  };
}

export async function writeSourceWatchRegistryReport(repoRoot = process.cwd(), options = {}) {
  const outputRel = options.outputRel ?? SOURCE_WATCH_REGISTRY_REPORT_REL;
  const outputPath = path.join(repoRoot, outputRel);
  const report = buildSourceWatchRegistryReport(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { outputRel, report };
}

async function main() {
  const { outputRel, report } = await writeSourceWatchRegistryReport(process.cwd());
  process.stdout.write(
    [
      "OPENCLAW_SOURCE_WATCH_REGISTRY=OK",
      `path=${outputRel}`,
      `sources=${report.summary.totalSources}`,
      `mode=${report.mode}`,
      `next=${report.nextSafeTask.id}`,
    ].join(" ") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `OPENCLAW_SOURCE_WATCH_REGISTRY=FAIL ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
