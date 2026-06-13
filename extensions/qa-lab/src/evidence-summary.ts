// Qa Lab plugin module implements QA evidence summary behavior.
import { z } from "zod";
import { splitQaModelRef } from "./model-selection.js";
import { getQaProvider, type QaProviderMode } from "./providers/index.js";

export const QA_EVIDENCE_SUMMARY_KIND = "openclaw.qa.evidence-summary";
export const QA_EVIDENCE_FILENAME = "qa-evidence.json";
export const QA_EVIDENCE_SUMMARY_SCHEMA_VERSION = 2;

const qaEvidenceStatusSchema = z.enum(["pass", "fail", "blocked", "skipped"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const nullableStringSchema = nonEmptyStringSchema.nullable();
const qaEvidenceProfileIdSchema = nonEmptyStringSchema;
const qaEvidenceIdSchema = z.object({ id: nonEmptyStringSchema });

const qaEvidenceProviderSchema = z
  .object({
    id: nonEmptyStringSchema,
    live: z.boolean(),
    model: z
      .object({
        name: nullableStringSchema,
        ref: nullableStringSchema,
      })
      .strict(),
    fixture: nonEmptyStringSchema.optional(),
    auth: nonEmptyStringSchema.optional(),
  })
  .strict();

const qaEvidenceChannelSchema = z
  .object({
    id: nonEmptyStringSchema,
    live: z.boolean(),
    driver: nonEmptyStringSchema.optional(),
  })
  .strict();

const qaEvidenceEnvironmentSchema = z
  .object({
    ref: nullableStringSchema,
    os: nonEmptyStringSchema,
    nodeVersion: nonEmptyStringSchema,
  })
  .strict();

const qaEvidencePackageSourceSchema = z
  .object({
    kind: nonEmptyStringSchema,
    spec: nonEmptyStringSchema.optional(),
    sha: nonEmptyStringSchema.optional(),
  })
  .strict();

const qaEvidenceFailureSchema = z
  .object({
    class: nonEmptyStringSchema.optional(),
    reason: nonEmptyStringSchema,
  })
  .strict();

const qaEvidenceTimingSchema = z
  .object({
    wallMs: z.number().finite().positive().optional(),
    rttMs: z.number().finite().positive().optional(),
    avgMs: z.number().finite().positive().optional(),
    p50Ms: z.number().finite().positive().optional(),
    p95Ms: z.number().finite().positive().optional(),
    maxMs: z.number().finite().positive().optional(),
    samples: z.number().int().positive().optional(),
    failedSamples: z.number().int().nonnegative().optional(),
  })
  .strict();

const qaEvidenceTestSchema = z
  .object({
    kind: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    source: z
      .object({
        path: nonEmptyStringSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const qaEvidenceRefSchema = z
  .object({
    kind: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  })
  .strict();

const qaEvidenceCoverageSchema = qaEvidenceIdSchema
  .extend({
    role: nonEmptyStringSchema,
    surfaceIds: z.array(nonEmptyStringSchema),
    categoryIds: z.array(nonEmptyStringSchema),
  })
  .strict();

const qaEvidenceMappingSchema = z
  .object({
    profile: qaEvidenceProfileIdSchema,
    coverage: z.array(qaEvidenceCoverageSchema),
    refs: z.array(qaEvidenceRefSchema).optional(),
    runtimeParityTier: nonEmptyStringSchema.optional(),
  })
  .strict();

const qaEvidenceArtifactSchema = z
  .object({
    kind: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    source: nonEmptyStringSchema,
  })
  .strict();

const qaEvidenceExecutionSchema = z
  .object({
    runner: nonEmptyStringSchema,
    environment: qaEvidenceEnvironmentSchema,
    provider: qaEvidenceProviderSchema,
    channel: qaEvidenceChannelSchema.optional(),
    packageSource: qaEvidencePackageSourceSchema,
    artifacts: z.array(qaEvidenceArtifactSchema),
  })
  .strict();

const qaEvidenceResultSchema = z
  .object({
    status: qaEvidenceStatusSchema,
    failure: qaEvidenceFailureSchema.optional(),
    timing: qaEvidenceTimingSchema.optional(),
  })
  .strict();

export const qaEvidenceSummaryEntrySchema = z
  .object({
    test: qaEvidenceTestSchema,
    mapping: qaEvidenceMappingSchema,
    execution: qaEvidenceExecutionSchema,
    result: qaEvidenceResultSchema,
  })
  .strict();

export const qaEvidenceSummarySchema = z
  .object({
    kind: z.literal(QA_EVIDENCE_SUMMARY_KIND),
    schemaVersion: z.literal(QA_EVIDENCE_SUMMARY_SCHEMA_VERSION),
    generatedAt: nonEmptyStringSchema,
    entries: z.array(qaEvidenceSummaryEntrySchema),
  })
  .strict();

export type QaEvidenceProfile = z.infer<typeof qaEvidenceProfileIdSchema>;
export type QaEvidenceStatus = z.infer<typeof qaEvidenceStatusSchema>;
export type QaEvidenceTiming = z.infer<typeof qaEvidenceTimingSchema>;
export type QaEvidencePackageSource = z.infer<typeof qaEvidencePackageSourceSchema>;
export type QaEvidenceSummaryEntry = z.infer<typeof qaEvidenceSummaryEntrySchema>;
export type QaEvidenceSummaryJson = z.infer<typeof qaEvidenceSummarySchema>;

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
  runtimeParityTier?: string;
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
};

type QaEvidenceScenarioResultInput = {
  name: string;
  status: QaEvidenceStatusInput;
  details?: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs?: number;
  };
};

type QaEvidenceLiveTransportCheckInput = {
  id: string;
  title: string;
  status: QaEvidenceStatusInput;
  details: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs?: number;
  };
  // Here "standard" means a taxonomy-backed requirement standard, not the default lane.
  standardId?: string;
  artifactPaths?: Readonly<Record<string, string>>;
};

type QaEvidenceRttInput = Pick<QaEvidenceScenarioResultInput, "rttMeasurement" | "rttMs">;

type QaEvidenceTestTargetInput = {
  id: string;
  title: string;
  sourcePath: string;
  primaryCoverageIds?: readonly string[];
  secondaryCoverageIds?: readonly string[];
  surfaceIds: readonly string[];
  categoryIds: readonly string[];
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
  env?: NodeJS.ProcessEnv;
  generatedAt: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  channelDriver?: string;
  packageSource?: QaEvidencePackageSource;
  profile?: QaEvidenceProfile;
  runner?: string;
};

function buildQaEvidenceRefs(params: {
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
}) {
  const buildRef = (kind: "docs" | "code", refPath: string) => {
    const ref = {
      kind,
      path: refPath,
    };
    return ref;
  };
  const refs = [
    ...(params.docsRefs ?? []).map((path) => buildRef("docs", path)),
    ...(params.codeRefs ?? []).map((path) => buildRef("code", path)),
  ];
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.path}`, ref])).values()];
}

function buildQaEvidenceCoverage(params: {
  primaryIds?: readonly string[];
  secondaryIds?: readonly string[];
  surfaceIds?: readonly string[];
  categoryIds?: readonly string[];
}) {
  const surfaceIds = uniqueSortedStrings(params.surfaceIds ?? []);
  const categoryIds = uniqueSortedStrings(params.categoryIds ?? []);
  const buildCoverage = (id: string, role: "primary" | "secondary") => ({
    id,
    role,
    surfaceIds,
    categoryIds: role === "primary" ? categoryIds : [],
  });
  return [
    ...uniqueSortedStrings(params.primaryIds ?? []).map((id) => buildCoverage(id, "primary")),
    ...uniqueSortedStrings(params.secondaryIds ?? []).map((id) => buildCoverage(id, "secondary")),
  ];
}

function buildQaEvidenceArtifacts(paths: readonly QaEvidenceArtifactInput[], source: string) {
  return paths.map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
    source,
  }));
}

function buildQaEvidenceNamedArtifacts(paths: Readonly<Record<string, string>>, source: string) {
  return Object.entries(paths).map(([kind, artifactPath]) => ({
    kind,
    path: artifactPath,
    source,
  }));
}

function uniqueSortedStrings(values: readonly (string | undefined)[]) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function resolveQaEvidenceProfile(params: {
  env?: NodeJS.ProcessEnv;
  fallback: QaEvidenceProfile;
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

  return params.fallback;
}

function resolveQaEvidenceRunner(params: { env?: NodeJS.ProcessEnv; fallback?: string }) {
  return params.env?.OPENCLAW_QA_RUNNER?.trim() || params.fallback || "host";
}

function resolveQaEvidenceChannelDriver(params: { env?: NodeJS.ProcessEnv; fallback?: string }) {
  const id =
    params.fallback?.trim() ||
    params.env?.OPENCLAW_QA_CHANNEL_DRIVER?.trim() ||
    params.env?.OPENCLAW_E2E_CHANNEL_DRIVER?.trim();
  return id ? { id } : undefined;
}

function resolveQaEvidenceEnvironment(env: NodeJS.ProcessEnv | undefined) {
  return {
    ref: env?.OPENCLAW_QA_REF?.trim() || env?.GITHUB_SHA?.trim() || null,
    os: process.platform,
    nodeVersion: process.version,
  };
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

function resolveQaEvidenceBuildPackageSource(params: QaEvidenceBuildBase) {
  return params.packageSource ?? resolveQaEvidencePackageSource(params.env);
}

function buildQaEvidenceProvider(params: { providerMode: QaProviderMode; primaryModel: string }) {
  const provider = getQaProvider(params.providerMode);
  const split = splitQaModelRef(params.primaryModel);
  const providerShape = {
    id: split?.provider ?? params.providerMode,
    model: {
      name: split?.model ?? null,
      ref: params.primaryModel || null,
    },
  };
  if (provider.kind === "live") {
    return {
      ...providerShape,
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

function normalizeQaEvidenceStatus(status: QaEvidenceStatusInput): QaEvidenceStatus {
  return status === "skip" ? "skipped" : status;
}

function failureForResult(result: {
  details?: string;
  failureMessage?: string;
  status: QaEvidenceStatusInput;
}) {
  const status = normalizeQaEvidenceStatus(result.status);
  if (status === "pass") {
    return undefined;
  }
  return {
    reason: result.details?.trim() || result.failureMessage?.trim() || `${status} test`,
  };
}

function timingForRttResult(check: QaEvidenceRttInput) {
  const rttMs = check.rttMeasurement?.finalMatchedReplyRttMs ?? check.rttMs;
  return typeof rttMs === "number" && Number.isFinite(rttMs) && rttMs > 0 ? { rttMs } : undefined;
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
) {
  return {
    status: normalizeQaEvidenceStatus(result.status),
    failure: failureForResult(result),
    timing,
  };
}

function buildQaEvidenceSummary(params: {
  entries: QaEvidenceSummaryEntry[];
  generatedAt: string;
}): QaEvidenceSummaryJson {
  return qaEvidenceSummarySchema.parse({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    entries: params.entries,
  });
}

export function validateQaEvidenceSummaryJson(summary: unknown): QaEvidenceSummaryJson {
  return qaEvidenceSummarySchema.parse(summary);
}

export function buildQaSuiteEvidenceSummary(
  params: QaEvidenceBuildBase & {
    channelId: string;
    scenarioDefinitions: readonly QaEvidenceScenarioDefinitionInput[];
    scenarioResults: readonly QaEvidenceScenarioResultInput[];
  },
): QaEvidenceSummaryJson {
  const provider = buildQaEvidenceProvider(params);
  const environment = resolveQaEvidenceEnvironment(params.env);
  const packageSource = resolveQaEvidenceBuildPackageSource(params);
  const runner = resolveQaEvidenceRunner({ env: params.env, fallback: params.runner });
  const profile = resolveQaEvidenceProfile({
    env: params.env,
    fallback: provider.live ? "release" : "smoke-ci",
    explicit: params.profile,
  });
  const channelDriver = resolveQaEvidenceChannelDriver({
    env: params.env,
    fallback: params.channelDriver,
  });
  const entries = params.scenarioResults.map((result, index): QaEvidenceSummaryEntry => {
    const scenario = params.scenarioDefinitions[index];
    const primaryCoverageIds = uniqueSortedStrings(scenario?.coverage?.primary ?? []);
    const coverageIds = uniqueSortedStrings([
      ...(scenario?.coverage?.primary ?? []),
      ...(scenario?.coverage?.secondary ?? []),
    ]);
    const surfaceIds = uniqueSortedStrings(
      scenario?.surfaces && scenario.surfaces.length > 0 ? scenario.surfaces : [scenario?.surface],
    );
    const runtimeParityTier = scenario?.runtimeParityTier;
    const testId = scenario?.id ?? `scenario-${index + 1}`;
    const refs = buildQaEvidenceRefs({
      docsRefs: scenario?.docsRefs,
      codeRefs: scenario?.codeRefs,
    });
    const timing = timingForRttResult(result);
    return {
      test: {
        kind: "qa-scenario",
        id: testId,
        title: scenario?.title ?? result.name,
        source: scenario?.sourcePath ? { path: scenario.sourcePath } : undefined,
      },
      mapping: {
        profile,
        coverage: buildQaEvidenceCoverage({
          primaryIds: primaryCoverageIds,
          secondaryIds: coverageIds.filter(
            (coverageId) => !primaryCoverageIds.includes(coverageId),
          ),
          surfaceIds,
          categoryIds: uniqueSortedStrings([scenario?.category, ...primaryCoverageIds]),
        }),
        refs: refs.length > 0 ? refs : undefined,
        runtimeParityTier,
      },
      execution: {
        runner,
        environment,
        provider,
        channel: {
          id: params.channelId,
          live: false,
          driver: channelDriver?.id,
        },
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, "qa-suite"),
      },
      result: resultForEvidence(result, timing),
    };
  });
  return buildQaEvidenceSummary({ generatedAt: params.generatedAt, entries });
}

function buildTestRunnerEvidenceSummary(
  params: QaEvidenceBuildBase & {
    defaultRunner: string;
    testKind: string;
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryJson {
  const provider = buildQaEvidenceProvider(params);
  const environment = resolveQaEvidenceEnvironment(params.env);
  const packageSource = resolveQaEvidenceBuildPackageSource(params);
  const runner = resolveQaEvidenceRunner({
    env: params.env,
    fallback: params.runner ?? params.defaultRunner,
  });
  const profile = resolveQaEvidenceProfile({
    env: params.env,
    fallback: provider.live ? "release" : "smoke-ci",
    explicit: params.profile,
  });
  const targetById = new Map(params.targets.map((target) => [target.id, target]));
  const targetByPath = new Map(params.targets.map((target) => [target.sourcePath, target]));
  const entries = params.results.map((result, index): QaEvidenceSummaryEntry => {
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
        kind: params.testKind,
        id: target?.id ?? fallbackId,
        title: target?.title ?? result.title ?? fallbackId,
        source: sourcePath ? { path: sourcePath } : undefined,
      },
      mapping: {
        profile,
        coverage: buildQaEvidenceCoverage({
          primaryIds: target?.primaryCoverageIds ?? [],
          secondaryIds: target?.secondaryCoverageIds ?? [],
          surfaceIds: target?.surfaceIds ?? [],
          categoryIds: target?.categoryIds ?? [],
        }),
        refs: refs.length > 0 ? refs : undefined,
      },
      execution: {
        runner,
        environment,
        provider,
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, runner),
      },
      result: resultForEvidence(result, timing),
    };
  });
  return buildQaEvidenceSummary({ generatedAt: params.generatedAt, entries });
}

export function buildVitestEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryJson {
  return buildTestRunnerEvidenceSummary({
    ...params,
    defaultRunner: "vitest",
    testKind: "vitest-test",
    runner: params.runner ?? "vitest",
  });
}

export function buildPlaywrightEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryJson {
  return buildTestRunnerEvidenceSummary({
    ...params,
    defaultRunner: "playwright",
    testKind: "playwright-test",
    runner: params.runner ?? "playwright",
  });
}

export function buildLiveTransportEvidenceSummary(
  params: QaEvidenceBuildBase & {
    checks: readonly QaEvidenceLiveTransportCheckInput[];
    transportId: string;
  },
): QaEvidenceSummaryJson {
  const provider = buildQaEvidenceProvider(params);
  const environment = resolveQaEvidenceEnvironment(params.env);
  const packageSource = resolveQaEvidenceBuildPackageSource(params);
  const runner = resolveQaEvidenceRunner({ env: params.env, fallback: params.runner });
  const profile = resolveQaEvidenceProfile({
    env: params.env,
    fallback: "release",
    explicit: params.profile,
  });
  const channelDriver = resolveQaEvidenceChannelDriver({
    env: params.env,
    fallback: params.channelDriver ?? "native",
  }) ?? { id: "native" };
  const entries = params.checks.map((check): QaEvidenceSummaryEntry => {
    const testId = check.id;
    const standardCoverageId = check.standardId
      ? `channels.${params.transportId}.${check.standardId}`
      : undefined;
    const coverage = [
      {
        id: `channels.${params.transportId}.live`,
        role: "live-transport",
        surfaceIds: [`channels.${params.transportId}`],
        categoryIds: [`channels.${params.transportId}.live`],
      },
    ];
    if (standardCoverageId) {
      coverage.push({
        id: standardCoverageId,
        role: "live-transport-standard",
        surfaceIds: [`channels.${params.transportId}`],
        categoryIds: [`channels.${params.transportId}.live`],
      });
    }
    const timing = timingForRttResult(check);
    return {
      test: {
        kind: "live-transport-check",
        id: testId,
        title: check.title,
      },
      mapping: {
        profile,
        coverage,
      },
      execution: {
        runner,
        environment,
        provider,
        channel: {
          id: params.transportId,
          live: true,
          driver: channelDriver.id,
        },
        packageSource,
        artifacts: [
          ...buildQaEvidenceArtifacts(params.artifactPaths, `${params.transportId}-live-transport`),
          ...buildQaEvidenceNamedArtifacts(
            check.artifactPaths ?? {},
            `${params.transportId}-live-transport:${testId}`,
          ),
        ],
      },
      result: resultForEvidence(check, timing),
    };
  });
  return buildQaEvidenceSummary({ generatedAt: params.generatedAt, entries });
}
