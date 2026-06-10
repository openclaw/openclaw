// Qa Lab plugin module implements normalized evidence summary behavior.
import { z } from "zod";
import { splitQaModelRef } from "./model-selection.js";
import { getQaProvider, type QaProviderMode } from "./providers/index.js";

export const QA_EVIDENCE_SUMMARY_KIND = "openclaw.qa.evidence-summary";
export const QA_EVIDENCE_SUMMARY_FILENAME = "qa-evidence-summary.json";
export const QA_EVIDENCE_SUMMARY_SCHEMA_VERSION = 2;

const qaEvidenceStatusSchema = z.enum(["pass", "fail", "blocked", "skipped"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const qaEvidenceProfileSchema = nonEmptyStringSchema;

const qaEvidenceProviderSchema = z
  .object({
    id: nonEmptyStringSchema,
    live: z.boolean(),
    model: z
      .object({
        name: nonEmptyStringSchema.nullable(),
        ref: nonEmptyStringSchema.nullable(),
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
    ref: nonEmptyStringSchema.nullable(),
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
    p50Ms: z.number().finite().positive().optional(),
    p95Ms: z.number().finite().positive().optional(),
    samples: z.number().int().positive().optional(),
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
    id: nonEmptyStringSchema,
    kind: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    sourcePath: nonEmptyStringSchema.optional(),
  })
  .strict();

const qaEvidenceCoverageSchema = z
  .object({
    id: nonEmptyStringSchema,
    role: nonEmptyStringSchema,
    sourcePath: nonEmptyStringSchema.optional(),
    surfaceIds: z.array(nonEmptyStringSchema),
    categoryIds: z.array(nonEmptyStringSchema),
    refIds: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

const qaEvidenceMappingSchema = z
  .object({
    profile: z
      .object({
        id: qaEvidenceProfileSchema,
        sourcePath: nonEmptyStringSchema.optional(),
      })
      .strict(),
    taxonomy: z
      .object({
        sourcePath: nonEmptyStringSchema,
      })
      .strict()
      .optional(),
    coverage: z.array(qaEvidenceCoverageSchema),
    refs: z.array(qaEvidenceRefSchema).optional(),
    runtimeParity: z
      .object({
        id: nonEmptyStringSchema,
        sourcePath: nonEmptyStringSchema.optional(),
      })
      .strict()
      .optional(),
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
    runner: z
      .object({
        id: nonEmptyStringSchema,
      })
      .strict(),
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

export type QaEvidenceProfile = z.infer<typeof qaEvidenceProfileSchema>;
export type QaEvidenceStatus = z.infer<typeof qaEvidenceStatusSchema>;
export type QaEvidenceSummaryEntry = z.infer<typeof qaEvidenceSummaryEntrySchema>;
export type QaEvidenceSummaryJson = z.infer<typeof qaEvidenceSummarySchema>;

type QaEvidenceStatusInput = QaEvidenceStatus | "skip";

type QaEvidenceScenarioSpecInput = {
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
  runtimeParity?: string;
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
};

type QaEvidenceScenarioResultInput = {
  id?: string;
  name?: string;
  standardId?: string;
  title?: string;
  status: QaEvidenceStatusInput;
  details?: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs?: number;
  };
};

type QaEvidenceLiveTransportCheckInput = {
  id?: string;
  name?: string;
  standardId?: string;
  title?: string;
  status: QaEvidenceStatusInput;
  details?: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs?: number;
  };
};

type QaEvidenceTestTargetInput = {
  id: string;
  title: string;
  sourcePath: string;
  coverageIds: readonly string[];
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

type QaEvidenceBuildBase = {
  artifactPaths: readonly string[];
  env?: NodeJS.ProcessEnv;
  generatedAt: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  channelDriver?: string;
  profile?: QaEvidenceProfile;
  runner?: string;
};

function buildQaEvidenceTest(params: {
  kind: string;
  id: string;
  title: string;
  sourcePath?: string;
}) {
  return {
    kind: params.kind,
    id: params.id,
    title: params.title,
    ...(params.sourcePath ? { source: { path: params.sourcePath } } : {}),
  };
}

function buildQaEvidenceRefs(params: {
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
  sourcePath?: string;
}) {
  const refs = [
    ...(params.docsRefs ?? []).map((path) => ({
      id: `docs:${path}`,
      kind: "docs",
      path,
      ...(params.sourcePath ? { sourcePath: params.sourcePath } : {}),
    })),
    ...(params.codeRefs ?? []).map((path) => ({
      id: `code:${path}`,
      kind: "code",
      path,
      ...(params.sourcePath ? { sourcePath: params.sourcePath } : {}),
    })),
  ];
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}

function buildQaEvidenceCoverage(params: {
  primaryIds?: readonly string[];
  secondaryIds?: readonly string[];
  surfaceIds?: readonly string[];
  categoryIds?: readonly string[];
  refIds?: readonly string[];
  sourcePath?: string;
}) {
  const surfaceIds = uniqueSortedStrings(params.surfaceIds ?? []);
  const categoryIds = uniqueSortedStrings(params.categoryIds ?? []);
  const refIds = uniqueSortedStrings(params.refIds ?? []);
  return [
    ...uniqueSortedStrings(params.primaryIds ?? []).map((id) => ({
      id,
      role: "primary",
      ...(params.sourcePath ? { sourcePath: params.sourcePath } : {}),
      surfaceIds,
      categoryIds,
      ...(refIds.length > 0 ? { refIds } : {}),
    })),
    ...uniqueSortedStrings(params.secondaryIds ?? []).map((id) => ({
      id,
      role: "secondary",
      ...(params.sourcePath ? { sourcePath: params.sourcePath } : {}),
      surfaceIds,
      categoryIds: [],
      ...(refIds.length > 0 ? { refIds } : {}),
    })),
  ];
}

function inferQaEvidenceArtifactKind(path: string) {
  const normalized = path.toLowerCase();
  if (normalized.includes("observed-messages")) {
    return "transport-observations";
  }
  if (normalized.includes("summary")) {
    return "summary";
  }
  if (normalized.includes("report")) {
    return "report";
  }
  return "runner-result";
}

function buildQaEvidenceArtifacts(paths: readonly string[], source: string) {
  return paths.map((artifactPath) => ({
    kind: inferQaEvidenceArtifactKind(artifactPath),
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
  for (const [source, value] of envProfiles) {
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
  const spec =
    env?.OPENCLAW_QA_PACKAGE_SOURCE?.trim() ||
    env?.OPENCLAW_PACKAGE_SPEC?.trim() ||
    env?.OPENCLAW_NPM_PACKAGE_SPEC?.trim() ||
    env?.OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE?.trim() ||
    env?.OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC?.trim() ||
    env?.OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ?.trim() ||
    env?.OPENCLAW_CURRENT_PACKAGE_TGZ?.trim() ||
    undefined;
  const sha =
    env?.OPENCLAW_QA_PACKAGE_SOURCE_SHA?.trim() ||
    env?.OPENCLAW_PACKAGE_SOURCE_SHA?.trim() ||
    undefined;
  const explicitKind = env?.OPENCLAW_QA_PACKAGE_SOURCE_KIND?.trim();
  const kind =
    explicitKind ||
    (spec && spec.endsWith(".tgz") ? "packed-tarball" : spec ? "npm-package" : "source-checkout");
  return {
    kind,
    ...(spec ? { spec } : {}),
    ...(sha ? { sha } : {}),
  };
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

function timingForLiveTransportCheck(check: QaEvidenceLiveTransportCheckInput) {
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
    scenarioSpecs: readonly QaEvidenceScenarioSpecInput[];
    scenarioResults: readonly QaEvidenceScenarioResultInput[];
  },
): QaEvidenceSummaryJson {
  const provider = buildQaEvidenceProvider(params);
  const environment = resolveQaEvidenceEnvironment(params.env);
  const packageSource = resolveQaEvidencePackageSource(params.env);
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
    const scenario = params.scenarioSpecs[index];
    const primaryCoverageIds = uniqueSortedStrings(scenario?.coverage?.primary ?? []);
    const coverageIds = uniqueSortedStrings([
      ...(scenario?.coverage?.primary ?? []),
      ...(scenario?.coverage?.secondary ?? []),
    ]);
    const surfaceIds = uniqueSortedStrings([...(scenario?.surfaces ?? []), scenario?.surface]);
    const runtimeParity = scenario?.runtimeParity ?? scenario?.runtimeParityTier;
    const testId = scenario?.id ?? result.id ?? result.name ?? `scenario-${index + 1}`;
    const refs = buildQaEvidenceRefs({
      docsRefs: scenario?.docsRefs,
      codeRefs: scenario?.codeRefs,
      sourcePath: scenario?.sourcePath,
    });
    const refIds = refs.map((ref) => ref.id);
    return {
      test: buildQaEvidenceTest({
        kind: "qa-scenario",
        id: testId,
        title: scenario?.title ?? result.title ?? result.name ?? `Scenario ${index + 1}`,
        sourcePath: scenario?.sourcePath,
      }),
      mapping: {
        profile: {
          id: profile,
        },
        coverage: buildQaEvidenceCoverage({
          primaryIds: primaryCoverageIds,
          secondaryIds: coverageIds.filter(
            (coverageId) => !primaryCoverageIds.includes(coverageId),
          ),
          surfaceIds,
          categoryIds: uniqueSortedStrings([scenario?.category, ...primaryCoverageIds]),
          refIds,
          sourcePath: scenario?.sourcePath,
        }),
        ...(refs.length > 0 ? { refs } : {}),
        ...(runtimeParity
          ? {
              runtimeParity: {
                id: runtimeParity,
                ...(scenario?.sourcePath ? { sourcePath: scenario.sourcePath } : {}),
              },
            }
          : {}),
      },
      execution: {
        runner: {
          id: runner,
        },
        environment,
        provider,
        channel: {
          id: params.channelId,
          live: false,
          ...(channelDriver ? { driver: channelDriver.id } : {}),
        },
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, "qa-suite"),
      },
      result: {
        status: normalizeQaEvidenceStatus(result.status),
        ...(failureForResult(result) ? { failure: failureForResult(result) } : {}),
        ...(timingForLiveTransportCheck(result)
          ? { timing: timingForLiveTransportCheck(result) }
          : {}),
      },
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
  const packageSource = resolveQaEvidencePackageSource(params.env);
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
      sourcePath: target?.sourcePath,
    });
    return {
      test: buildQaEvidenceTest({
        kind: params.testKind,
        id: target?.id ?? fallbackId,
        title: target?.title ?? result.title ?? fallbackId,
        sourcePath,
      }),
      mapping: {
        profile: {
          id: profile,
        },
        coverage: buildQaEvidenceCoverage({
          primaryIds: target?.coverageIds ?? [],
          surfaceIds: target?.surfaceIds ?? [],
          categoryIds: target?.categoryIds ?? [],
          refIds: refs.map((ref) => ref.id),
          sourcePath: target?.sourcePath,
        }),
        ...(refs.length > 0 ? { refs } : {}),
      },
      execution: {
        runner: {
          id: runner,
        },
        environment,
        provider,
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, runner),
      },
      result: {
        status: normalizeQaEvidenceStatus(result.status),
        ...(failureForResult(result) ? { failure: failureForResult(result) } : {}),
        ...(timingForTestResult(result) ? { timing: timingForTestResult(result) } : {}),
      },
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
  const packageSource = resolveQaEvidencePackageSource(params.env);
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
  const entries = params.checks.map((check, index): QaEvidenceSummaryEntry => {
    const testId = check.id ?? check.name ?? `live-transport-check-${index + 1}`;
    const standardCoverageId = check.standardId
      ? `channels.${params.transportId}.${check.standardId}`
      : undefined;
    return {
      test: buildQaEvidenceTest({
        kind: "live-transport-check",
        id: testId,
        title: check.title ?? check.name ?? testId,
      }),
      mapping: {
        profile: {
          id: profile,
        },
        coverage: [
          {
            id: `channels.${params.transportId}.live`,
            role: "live-transport",
            surfaceIds: [`channels.${params.transportId}`],
            categoryIds: [`channels.${params.transportId}.live`],
          },
          ...(standardCoverageId
            ? [
                {
                  id: standardCoverageId,
                  role: "live-transport-standard",
                  surfaceIds: [`channels.${params.transportId}`],
                  categoryIds: [`channels.${params.transportId}.live`],
                },
              ]
            : []),
        ],
      },
      execution: {
        runner: {
          id: runner,
        },
        environment,
        provider,
        channel: {
          id: params.transportId,
          live: true,
          driver: channelDriver.id,
        },
        packageSource,
        artifacts: buildQaEvidenceArtifacts(
          params.artifactPaths,
          `${params.transportId}-live-transport`,
        ),
      },
      result: {
        status: normalizeQaEvidenceStatus(check.status),
        ...(failureForResult(check) ? { failure: failureForResult(check) } : {}),
        ...(timingForLiveTransportCheck(check)
          ? { timing: timingForLiveTransportCheck(check) }
          : {}),
      },
    };
  });
  return buildQaEvidenceSummary({ generatedAt: params.generatedAt, entries });
}
