// QA Lab plugin module implements QA evidence summary behavior.
import { normalizeSortedUniqueTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveQaEvidenceEnvironment } from "./evidence-environment.js";
import {
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  qaEvidenceRttMeasurementSchema,
  qaEvidenceSummarySchema,
  qaEvidenceSummaryV3Schema,
  qaVersionedEvidenceSummarySchema,
  resolveQaEvidenceContainment,
  type QaProfileEvidencePlan,
  type QaEvidenceStatus,
  type QaEvidenceTiming,
  type QaEvidenceRttMeasurement,
  type QaEvidencePackageSource,
  type QaEvidenceScorecardJson,
  type QaEvidenceSummaryV3Entry,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryV2Json,
  type QaEvidenceSummaryV3Json,
  type QaEvidenceSummaryJson,
  type QaEvidenceOccurrence,
  type QaEvidenceProfile,
  type QaEvidenceSummaryV2Entry,
} from "./evidence-summary-schema.js";
import { splitQaModelRef } from "./model-selection.js";
import { getQaProvider, type QaProviderMode } from "./providers/index.js";
import type { QaRuntimePairLane } from "./scenario-catalog.js";
import {
  readQaScorecardProfileOptions,
  type QaScorecardEvidenceMode,
} from "./scorecard-taxonomy.js";

export { QA_EVIDENCE_FILENAME, QA_EVIDENCE_SUMMARY_KIND } from "./evidence-summary-schema.js";
export type {
  QaEvidenceStatus,
  QaEvidenceTiming,
  QaEvidenceRttMeasurement,
  QaEvidencePackageSource,
  QaEvidenceScorecardJson,
  QaEvidenceSummaryV3Entry,
  QaEvidenceSummaryEntry,
  QaEvidenceSummaryV2Json,
  QaEvidenceSummaryV3Json,
  QaEvidenceSummaryJson,
  QaEvidenceOccurrence,
  QaEvidenceAssertion,
  QaEvidenceIdentity,
} from "./evidence-summary-schema.js";

export type QaEvidenceScenarioOutcome = {
  scenarioId: string;
  scenarioInstanceId: string | null;
  occurrenceId: string | null;
  status: QaEvidenceStatus | null;
};

type QaEvidenceStatusInput = QaEvidenceStatus | "skip";

type QaEvidenceScenarioDefinitionInput = {
  id: string;
  title: string;
  sourcePath?: string;
  surface?: string;
  surfaces?: readonly string[];
  category?: string;
  coverage?: {
    primary?: readonly string[];
    secondary?: readonly string[];
  };
  runtimePairLane?: QaRuntimePairLane;
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
};

type QaEvidenceScenarioResultInput = {
  name: string;
  status: QaEvidenceStatusInput;
  details?: string;
  timing?: QaEvidenceTiming;
  rttMs?: number;
  rttMeasurement?: Partial<QaEvidenceRttMeasurement>;
};

type QaEvidenceRttInput = Pick<
  QaEvidenceScenarioResultInput,
  "rttMeasurement" | "rttMs" | "timing"
>;

type QaEvidenceTestTargetInput = {
  id: string;
  title: string;
  sourcePath: string;
  primaryCoverageIds?: readonly string[];
  secondaryCoverageIds?: readonly string[];
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
};

type QaEvidenceTestResultInput = {
  id?: string;
  title?: string;
  sourcePath?: string;
  status: QaEvidenceStatusInput;
  durationMs?: number;
  failureMessage?: string;
};

type QaEvidenceArtifactInput = {
  kind: string;
  path: string;
};

type QaEvidenceBuildBase = {
  artifactPaths: readonly QaEvidenceArtifactInput[];
  evidenceMode?: QaScorecardEvidenceMode;
  env?: NodeJS.ProcessEnv;
  generatedAt: string;
  primaryModel: string;
  providerId?: string;
  providerMode: QaProviderMode;
  channelDriver?: string;
  packageSource?: QaEvidencePackageSource;
  profile?: QaEvidenceProfile;
  repoRoot?: string;
  runner?: string;
};

function buildQaEvidenceRefs(params: {
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
}) {
  const refs = [
    ...(params.docsRefs ?? []).map((path) => ({ kind: "docs" as const, path })),
    ...(params.codeRefs ?? []).map((path) => ({ kind: "code" as const, path })),
  ];
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.path}`, ref])).values()];
}

function buildQaEvidenceCoverage(params: {
  primaryCoverageIds?: readonly string[];
  secondaryCoverageIds?: readonly string[];
}) {
  return [
    ...normalizeSortedUniqueTrimmedStringList(params.primaryCoverageIds ?? []).map((id) => ({
      id,
      role: "primary" as const,
    })),
    ...normalizeSortedUniqueTrimmedStringList(params.secondaryCoverageIds ?? []).map((id) => ({
      id,
      role: "secondary" as const,
    })),
  ];
}

function buildQaEvidenceArtifacts(paths: readonly QaEvidenceArtifactInput[], source: string) {
  return paths.map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
    source,
  }));
}

export function resolveQaEvidenceProfile(params: {
  env?: NodeJS.ProcessEnv;
  explicit?: QaEvidenceProfile;
}) {
  if (params.explicit) {
    const explicit = params.explicit.trim();
    if (!explicit) {
      throw new Error("evidence profile must be a non-empty string.");
    }
    return explicit;
  }

  const envProfiles = [
    ["OPENCLAW_E2E_PROFILE", params.env?.OPENCLAW_E2E_PROFILE],
    ["OPENCLAW_QA_PROFILE", params.env?.OPENCLAW_QA_PROFILE],
  ] as const;
  for (const [, value] of envProfiles) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }
    return normalized;
  }

  return undefined;
}

function resolveQaEvidencePackageSource(env: NodeJS.ProcessEnv | undefined) {
  const spec = env?.OPENCLAW_QA_PACKAGE_SOURCE?.trim() || undefined;
  const sha = env?.OPENCLAW_QA_PACKAGE_SOURCE_SHA?.trim() || undefined;
  const explicitKind = env?.OPENCLAW_QA_PACKAGE_SOURCE_KIND?.trim();
  const kind =
    explicitKind ||
    (spec && spec.endsWith(".tgz") ? "packed-tarball" : spec ? "npm-package" : "source-checkout");
  return {
    kind,
    spec,
    sha,
  };
}

function buildQaEvidenceProvider(
  params: Pick<QaEvidenceBuildBase, "providerMode" | "primaryModel" | "providerId">,
) {
  const provider = getQaProvider(params.providerMode);
  const split = splitQaModelRef(params.primaryModel);
  const providerShape = {
    model: {
      name: split?.model ?? null,
      ref: params.primaryModel || null,
    },
  };
  if (provider.kind === "live") {
    return {
      ...providerShape,
      // A live run can know its provider even when its selected models differ.
      id: split?.provider ?? (params.providerId?.trim() || params.providerMode),
      live: true,
      auth: params.providerMode,
    };
  }
  const mockProviderId =
    split?.provider && split.provider !== params.providerMode
      ? split.provider
      : params.providerMode === "mock-openai"
        ? "openai"
        : (split?.provider ?? params.providerMode);
  return {
    ...providerShape,
    id: mockProviderId,
    live: false,
    fixture: params.providerMode,
  };
}

function resolveQaEvidenceBuildContext(params: QaEvidenceBuildBase, defaultRunner?: string) {
  return {
    profile: resolveQaEvidenceProfile({ env: params.env, explicit: params.profile }),
    executionBase: {
      runner: params.env?.OPENCLAW_QA_RUNNER?.trim() || (params.runner ?? defaultRunner) || "host",
      environment: resolveQaEvidenceEnvironment({ env: params.env, repoRoot: params.repoRoot }),
      provider: buildQaEvidenceProvider(params),
    },
    packageSource: params.packageSource ?? resolveQaEvidencePackageSource(params.env),
  };
}

function normalizeQaEvidenceStatus(status: QaEvidenceStatusInput): QaEvidenceStatus {
  return status === "skip" ? "skipped" : status;
}

function evidenceForRttResult(check: QaEvidenceRttInput) {
  const timing: QaEvidenceTiming = { ...check.timing };
  const parsedMeasurement = qaEvidenceRttMeasurementSchema.safeParse(check.rttMeasurement);
  const rttMeasurement = parsedMeasurement.success ? parsedMeasurement.data : undefined;
  const fallbackRttMs = check.rttMeasurement?.finalMatchedReplyRttMs ?? check.rttMs;
  if (rttMeasurement) {
    timing.rttMs = rttMeasurement.finalMatchedReplyRttMs;
  } else if (
    timing.rttMs === undefined &&
    typeof fallbackRttMs === "number" &&
    Number.isFinite(fallbackRttMs) &&
    fallbackRttMs > 0
  ) {
    timing.rttMs = fallbackRttMs;
  }
  return {
    timing: Object.keys(timing).length > 0 ? timing : undefined,
    rttMeasurement,
  };
}

function timingForTestResult(result: QaEvidenceTestResultInput) {
  return typeof result.durationMs === "number" &&
    Number.isFinite(result.durationMs) &&
    result.durationMs > 0
    ? { wallMs: result.durationMs }
    : undefined;
}

function resultForEvidence(
  result: { details?: string; failureMessage?: string; status: QaEvidenceStatusInput },
  timing?: QaEvidenceTiming,
  rttMeasurement?: QaEvidenceRttMeasurement,
) {
  const status = normalizeQaEvidenceStatus(result.status);
  return {
    status,
    failure:
      status === "pass"
        ? undefined
        : { reason: result.details?.trim() || result.failureMessage?.trim() || `${status} test` },
    timing,
    rttMeasurement,
  };
}

function buildQaEvidenceSummary(params: {
  entries: QaEvidenceSummaryV2Entry[];
  evidenceMode?: QaScorecardEvidenceMode;
  generatedAt: string;
  profile?: QaEvidenceProfile;
  profilePlan?: QaProfileEvidencePlan;
  scorecard?: QaEvidenceScorecardJson;
}): QaEvidenceSummaryV2Json {
  const profileOptions = readQaScorecardProfileOptions(params.profile);
  const evidenceMode = params.evidenceMode ?? profileOptions.evidenceMode;
  const entries =
    evidenceMode === "slim"
      ? params.entries.map((entry) => {
          const { execution: _execution, ...withoutExecution } = entry;
          return withoutExecution;
        })
      : params.entries;
  return qaEvidenceSummarySchema.parse({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode,
    entries,
    profile: params.profile,
    profilePlan: params.profilePlan,
    scorecard: params.scorecard,
  });
}

export function validateQaEvidenceSummaryJson(summary: unknown): QaEvidenceSummaryJson {
  return qaVersionedEvidenceSummarySchema.parse(summary);
}

/** Only the invocation owner can supply bindings; this constructor invents none. */
export function buildQaOccurrenceEvidenceSummary(params: {
  entries: QaEvidenceSummaryV3Entry[];
  occurrences: QaEvidenceOccurrence[];
  evidenceMode?: QaScorecardEvidenceMode;
  generatedAt: string;
  profile?: QaEvidenceProfile;
  profilePlan?: QaProfileEvidencePlan;
  scorecard?: QaEvidenceScorecardJson;
}): QaEvidenceSummaryV3Json {
  const evidenceMode =
    params.evidenceMode ?? readQaScorecardProfileOptions(params.profile).evidenceMode;
  return qaEvidenceSummaryV3Schema.parse({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: 3,
    generatedAt: params.generatedAt,
    evidenceMode,
    entries:
      evidenceMode === "slim"
        ? params.entries.map(({ execution: _execution, ...entry }) => entry)
        : params.entries,
    occurrences: params.occurrences,
    profile: params.profile,
    profilePlan: params.profilePlan,
    scorecard: params.scorecard,
  });
}

export function getEffectiveQaEvidenceEntries(
  summary: QaEvidenceSummaryJson,
): QaEvidenceSummaryEntry[] {
  if (summary.schemaVersion === 2) {
    return summary.entries;
  }
  const containment = resolveQaEvidenceContainment(summary.occurrences, summary.entries);
  return summary.entries.filter(
    (entry) => entry.effective && containment.isActive(entry.binding.occurrenceId),
  );
}

export function projectQaEvidenceScenarioOutcomes(
  summary: QaEvidenceSummaryJson,
): QaEvidenceScenarioOutcome[] {
  if (summary.schemaVersion === 2) {
    return summary.entries.map((entry) => ({
      scenarioId: entry.test.id,
      scenarioInstanceId: null,
      occurrenceId: null,
      status: entry.result.status,
    }));
  }
  const occurrences = new Map(summary.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const containment = resolveQaEvidenceContainment(summary.occurrences, summary.entries);
  const effective = new Set(
    getEffectiveQaEvidenceEntries(summary).map((entry) =>
      "binding" in entry ? entry.binding.occurrenceId : null,
    ),
  );
  const outcomes: QaEvidenceScenarioOutcome[] = [];
  for (const occurrence of summary.occurrences) {
    if (
      occurrence.scenario?.kind !== "instance" ||
      !occurrence.parentCell ||
      containment.parentById.has(occurrence.id)
    ) {
      continue;
    }
    const selectedId = occurrence.scenario.resultOccurrenceId;
    // An unresolved first scheduled instance must not disappear behind a later pass.
    outcomes.push({
      scenarioId: occurrence.parentCell.scenarioId,
      scenarioInstanceId: occurrence.id,
      occurrenceId: selectedId,
      status:
        selectedId !== null && effective.has(selectedId)
          ? (occurrences.get(selectedId)?.terminalStatus ?? null)
          : null,
    });
  }
  return outcomes;
}

export function mergeQaEvidenceSummaries(params: {
  evidenceSummaries: readonly QaEvidenceSummaryJson[];
  generatedAt: string;
}) {
  const summaries = params.evidenceSummaries.map(validateQaEvidenceSummaryJson);
  const versions = new Set(summaries.map((summary) => summary.schemaVersion));
  if (versions.size > 1) {
    throw new Error("cannot merge v2 and v3 evidence without an invocation-owned import");
  }
  const occurrences = new Map<string, QaEvidenceOccurrence>();
  for (const summary of summaries) {
    if (summary.schemaVersion !== 3) {
      continue;
    }
    for (const occurrence of summary.occurrences) {
      const previous = occurrences.get(occurrence.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(occurrence)) {
        throw new Error(`conflicting evidence occurrence ${occurrence.id}`);
      }
      occurrences.set(occurrence.id, occurrence);
    }
  }
  const profiles = [
    ...new Set(
      summaries
        .map((summary) => summary.profile?.trim())
        .filter((profile): profile is string => Boolean(profile)),
    ),
  ];
  return validateQaEvidenceSummaryJson({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: versions.has(3) ? 3 : QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode:
      summaries.length > 0 && summaries.every((summary) => summary.evidenceMode === "slim")
        ? "slim"
        : "full",
    entries: summaries.flatMap((summary) => summary.entries),
    profile: profiles.length === 1 ? profiles[0] : undefined,
    ...(versions.has(3) ? { occurrences: [...occurrences.values()] } : {}),
  });
}

export function attachQaEvidenceScorecard(params: {
  evidenceMode?: QaScorecardEvidenceMode;
  summary: QaEvidenceSummaryJson;
  profile: QaEvidenceProfile;
  profilePlan: QaProfileEvidencePlan;
  scorecard: QaEvidenceScorecardJson;
}): QaEvidenceSummaryJson {
  if (params.summary.schemaVersion === 3) {
    return buildQaOccurrenceEvidenceSummary({
      entries: params.summary.entries,
      occurrences: params.summary.occurrences,
      evidenceMode: params.evidenceMode ?? params.summary.evidenceMode,
      generatedAt: params.summary.generatedAt,
      profile: params.profile,
      profilePlan: params.profilePlan,
      scorecard: params.scorecard,
    });
  }
  return buildQaEvidenceSummary({
    entries: params.summary.entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.summary.generatedAt,
    profile: params.profile,
    profilePlan: params.profilePlan,
    scorecard: params.scorecard,
  });
}

export function buildQaSuiteEvidenceSummary(
  params: QaEvidenceBuildBase & {
    channelId: string;
    scenarioDefinitions: readonly QaEvidenceScenarioDefinitionInput[];
    scenarioResults: readonly QaEvidenceScenarioResultInput[];
  },
): QaEvidenceSummaryV2Json {
  const { executionBase, packageSource, profile } = resolveQaEvidenceBuildContext(params);
  const channelDriver = params.channelDriver?.trim() || undefined;
  const entries = params.scenarioResults.map((result, index): QaEvidenceSummaryV2Entry => {
    const scenario = params.scenarioDefinitions[index];
    const primaryCoverageIds = normalizeSortedUniqueTrimmedStringList(
      scenario?.coverage?.primary ?? [],
    );
    const coverageIds = normalizeSortedUniqueTrimmedStringList([
      ...(scenario?.coverage?.primary ?? []),
      ...(scenario?.coverage?.secondary ?? []),
    ]);
    const runtimePairLane = scenario?.runtimePairLane;
    const testId = scenario?.id ?? `scenario-${index + 1}`;
    const refs = buildQaEvidenceRefs({
      docsRefs: scenario?.docsRefs,
      codeRefs: scenario?.codeRefs,
    });
    const { timing, rttMeasurement } = evidenceForRttResult(result);
    return {
      test: {
        kind: "qa-scenario",
        id: testId,
        title: scenario?.title ?? result.name,
        source: scenario?.sourcePath ? { path: scenario.sourcePath } : undefined,
      },
      coverage: buildQaEvidenceCoverage({
        primaryCoverageIds,
        secondaryCoverageIds: coverageIds.filter(
          (coverageId) => !primaryCoverageIds.includes(coverageId),
        ),
      }),
      refs: refs.length > 0 ? refs : undefined,
      runtimePairLane,
      execution: {
        ...executionBase,
        channel: {
          id: params.channelId,
          live: channelDriver === "live",
          driver: channelDriver,
        },
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, "qa-suite"),
      },
      result: resultForEvidence(result, timing, rttMeasurement),
    };
  });
  return buildQaEvidenceSummary({
    entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.generatedAt,
    profile,
  });
}

type QaTestRunnerEvidenceInput = QaEvidenceBuildBase & {
  targets: readonly QaEvidenceTestTargetInput[];
  results: readonly QaEvidenceTestResultInput[];
};

function buildTestRunnerEvidenceSummary(
  params: QaTestRunnerEvidenceInput,
  defaultRunner: string,
  testKind: string,
): QaEvidenceSummaryV2Json {
  const { executionBase, packageSource, profile } = resolveQaEvidenceBuildContext(
    params,
    defaultRunner,
  );
  const targetById = new Map(params.targets.map((target) => [target.id, target]));
  const targetByPath = new Map(params.targets.map((target) => [target.sourcePath, target]));
  const entries = params.results.map((result, index): QaEvidenceSummaryV2Entry => {
    const target = result.id
      ? targetById.get(result.id)
      : result.sourcePath
        ? targetByPath.get(result.sourcePath)
        : undefined;
    const fallbackId = result.id ?? result.sourcePath ?? `test-${index + 1}`;
    const sourcePath = target?.sourcePath ?? result.sourcePath;
    const refs = buildQaEvidenceRefs({
      docsRefs: target?.docsRefs,
      codeRefs: target?.codeRefs,
    });
    const timing = timingForTestResult(result);
    return {
      test: {
        kind: testKind,
        id: target?.id ?? fallbackId,
        title: target?.title ?? result.title ?? fallbackId,
        source: sourcePath ? { path: sourcePath } : undefined,
      },
      coverage: buildQaEvidenceCoverage({
        primaryCoverageIds: target?.primaryCoverageIds ?? [],
        secondaryCoverageIds: target?.secondaryCoverageIds ?? [],
      }),
      refs: refs.length > 0 ? refs : undefined,
      execution: {
        ...executionBase,
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, executionBase.runner),
      },
      result: resultForEvidence(result, timing),
    };
  });
  return buildQaEvidenceSummary({
    entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.generatedAt,
    profile,
  });
}

export function buildVitestEvidenceSummary(
  params: QaTestRunnerEvidenceInput,
): QaEvidenceSummaryV2Json {
  return buildTestRunnerEvidenceSummary(params, "vitest", "vitest-test");
}

export function buildPlaywrightEvidenceSummary(
  params: QaTestRunnerEvidenceInput,
): QaEvidenceSummaryV2Json {
  return buildTestRunnerEvidenceSummary(params, "playwright", "playwright-test");
}

export function buildScriptEvidenceSummary(
  params: QaTestRunnerEvidenceInput,
): QaEvidenceSummaryV2Json {
  return buildTestRunnerEvidenceSummary(params, "script", "script-test");
}
