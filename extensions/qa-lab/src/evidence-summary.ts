// Qa Lab plugin module implements normalized evidence summary behavior.
import { z } from "zod";
import { splitQaModelRef } from "./model-selection.js";
import { getQaProvider, type QaProviderMode } from "./providers/index.js";

export const QA_EVIDENCE_SUMMARY_KIND = "openclaw.qa.evidence-summary";
export const QA_EVIDENCE_SUMMARY_SCHEMA_VERSION = 2;

const qaEvidenceProfileSchema = z.enum(["smoke-ci", "release"]);
const qaEvidenceStatusSchema = z.enum(["pass", "fail", "blocked"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const QA_EVIDENCE_TAXONOMY_REF = {
  sourcePath: "taxonomy.yaml",
  version: 1,
  processVersion: 3,
  snapshotDate: "2026-05-26",
  sourceRef: "origin/main@41eef4a7965",
} as const;
const legacyQaEvidenceProfileEnvAliases: Record<string, QaEvidenceProfile> = {
  advisory: "smoke-ci",
  extended: "smoke-ci",
  manual: "smoke-ci",
  soak: "release",
};

const qaEvidenceProviderSchema = z
  .object({
    id: nonEmptyStringSchema,
    modelName: nonEmptyStringSchema.nullable(),
    modelRef: nonEmptyStringSchema.nullable(),
  })
  .strict();

const qaEvidenceChannelSchema = z
  .object({
    id: nonEmptyStringSchema,
  })
  .strict();

const qaEvidenceTaxonomyRefSchema = z
  .object({
    sourcePath: nonEmptyStringSchema,
    version: z.number().int().positive(),
    processVersion: z.number().int().positive(),
    snapshotDate: nonEmptyStringSchema,
    sourceRef: nonEmptyStringSchema,
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

export const qaEvidenceSummaryEntrySchema = z
  .object({
    scenarioId: nonEmptyStringSchema,
    scenarioTitle: nonEmptyStringSchema,
    coverageIds: z.array(nonEmptyStringSchema),
    sourcePath: nonEmptyStringSchema.optional(),
    docsRefs: z.array(nonEmptyStringSchema).optional(),
    codeRefs: z.array(nonEmptyStringSchema).optional(),
    runtimeParity: nonEmptyStringSchema.optional(),
    scorecard: z
      .object({
        surfaceIds: z.array(nonEmptyStringSchema),
        categoryIds: z.array(nonEmptyStringSchema),
      })
      .strict(),
    profile: qaEvidenceProfileSchema,
    provider: qaEvidenceProviderSchema,
    model_live: z.boolean(),
    provider_fixture: nonEmptyStringSchema.optional(),
    provider_auth: nonEmptyStringSchema.optional(),
    channel: qaEvidenceChannelSchema.optional(),
    channel_live: z.boolean().optional(),
    channel_driver: nonEmptyStringSchema.optional(),
    surfaceId: nonEmptyStringSchema.optional(),
    runner: nonEmptyStringSchema,
    packageSource: qaEvidencePackageSourceSchema,
    environment: qaEvidenceEnvironmentSchema,
    artifactPaths: z.array(nonEmptyStringSchema),
    status: qaEvidenceStatusSchema,
    failure: qaEvidenceFailureSchema.optional(),
    timing: qaEvidenceTimingSchema.optional(),
  })
  .strict();

export const qaEvidenceSummarySchema = z
  .object({
    kind: z.literal(QA_EVIDENCE_SUMMARY_KIND),
    schemaVersion: z.literal(QA_EVIDENCE_SUMMARY_SCHEMA_VERSION),
    generatedAt: nonEmptyStringSchema,
    taxonomy: qaEvidenceTaxonomyRefSchema,
    entries: z.array(qaEvidenceSummaryEntrySchema),
  })
  .strict();

export type QaEvidenceProfile = z.infer<typeof qaEvidenceProfileSchema>;
export type QaEvidenceStatus = z.infer<typeof qaEvidenceStatusSchema>;
export type QaEvidenceSummaryEntry = z.infer<typeof qaEvidenceSummaryEntrySchema>;
export type QaEvidenceSummaryJson = z.infer<typeof qaEvidenceSummarySchema>;

type QaEvidenceScenarioStatusInput = "pass" | "fail" | "blocked";

type QaEvidenceCatalogScenarioInput = {
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
  title?: string;
  status: QaEvidenceScenarioStatusInput;
  details?: string;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs?: number;
  };
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

function uniqueSortedStrings(values: readonly (string | undefined)[]) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function parseQaEvidenceProfileEnv(
  source: string,
  value: string | undefined,
): QaEvidenceProfile | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = qaEvidenceProfileSchema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }
  const alias = legacyQaEvidenceProfileEnvAliases[normalized];
  if (alias) {
    return alias;
  }
  throw new Error(`${source} must be one of smoke-ci, release, got "${normalized}".`);
}

function resolveQaEvidenceProfile(params: {
  env?: NodeJS.ProcessEnv;
  fallback: QaEvidenceProfile;
  explicit?: QaEvidenceProfile;
}) {
  return (
    params.explicit ??
    parseQaEvidenceProfileEnv("OPENCLAW_E2E_PROFILE", params.env?.OPENCLAW_E2E_PROFILE) ??
    parseQaEvidenceProfileEnv("OPENCLAW_QA_PROFILE", params.env?.OPENCLAW_QA_PROFILE) ??
    params.fallback
  );
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
    modelName: split?.model ?? null,
    modelRef: params.primaryModel || null,
  };
  if (provider.kind === "live") {
    return {
      provider: providerShape,
      model_live: true,
      provider_auth: params.providerMode,
    };
  }
  const mockProviderId =
    split?.provider && split.provider !== params.providerMode
      ? split.provider
      : params.providerMode === "mock-openai"
        ? "openai"
        : (split?.provider ?? params.providerMode);
  return {
    provider: {
      ...providerShape,
      id: mockProviderId,
    },
    model_live: false,
    provider_fixture: params.providerMode,
  };
}

function failureForScenario(scenario: QaEvidenceScenarioResultInput) {
  if (scenario.status === "pass") {
    return undefined;
  }
  return {
    reason: scenario.details?.trim() || `${scenario.status} scenario`,
  };
}

function timingForScenario(scenario: QaEvidenceScenarioResultInput) {
  const rttMs = scenario.rttMeasurement?.finalMatchedReplyRttMs ?? scenario.rttMs;
  return typeof rttMs === "number" && Number.isFinite(rttMs) && rttMs > 0 ? { rttMs } : undefined;
}

function buildQaEvidenceSummary(params: {
  entries: QaEvidenceSummaryEntry[];
  generatedAt: string;
}): QaEvidenceSummaryJson {
  return qaEvidenceSummarySchema.parse({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    taxonomy: QA_EVIDENCE_TAXONOMY_REF,
    entries: params.entries,
  });
}

export function validateQaEvidenceSummaryJson(summary: unknown): QaEvidenceSummaryJson {
  return qaEvidenceSummarySchema.parse(summary);
}

export function buildQaSuiteEvidenceSummary(
  params: QaEvidenceBuildBase & {
    catalogScenarios: readonly QaEvidenceCatalogScenarioInput[];
    channelId: string;
    scenarios: readonly QaEvidenceScenarioResultInput[];
  },
): QaEvidenceSummaryJson {
  const provider = buildQaEvidenceProvider(params);
  const environment = resolveQaEvidenceEnvironment(params.env);
  const packageSource = resolveQaEvidencePackageSource(params.env);
  const runner = resolveQaEvidenceRunner({ env: params.env, fallback: params.runner });
  const profile = resolveQaEvidenceProfile({
    env: params.env,
    fallback: provider.model_live ? "release" : "smoke-ci",
    explicit: params.profile,
  });
  const channelDriver = resolveQaEvidenceChannelDriver({
    env: params.env,
    fallback: params.channelDriver,
  });
  const entries = params.scenarios.map((result, index): QaEvidenceSummaryEntry => {
    const scenario = params.catalogScenarios[index];
    const primaryCoverageIds = uniqueSortedStrings(scenario?.coverage?.primary ?? []);
    const coverageIds = uniqueSortedStrings([
      ...(scenario?.coverage?.primary ?? []),
      ...(scenario?.coverage?.secondary ?? []),
    ]);
    const surfaceIds = uniqueSortedStrings([...(scenario?.surfaces ?? []), scenario?.surface]);
    const runtimeParity = scenario?.runtimeParity ?? scenario?.runtimeParityTier;
    return {
      scenarioId: scenario?.id ?? result.id ?? result.name ?? `scenario-${index + 1}`,
      scenarioTitle: scenario?.title ?? result.title ?? result.name ?? `Scenario ${index + 1}`,
      coverageIds,
      ...(scenario?.sourcePath ? { sourcePath: scenario.sourcePath } : {}),
      ...(scenario?.docsRefs ? { docsRefs: [...scenario.docsRefs] } : {}),
      ...(scenario?.codeRefs ? { codeRefs: [...scenario.codeRefs] } : {}),
      ...(runtimeParity ? { runtimeParity } : {}),
      scorecard: {
        surfaceIds,
        categoryIds: uniqueSortedStrings([scenario?.category, ...primaryCoverageIds]),
      },
      profile,
      ...provider,
      channel: {
        id: params.channelId,
      },
      channel_live: false,
      ...(channelDriver ? { channel_driver: channelDriver.id } : {}),
      surfaceId: surfaceIds[0],
      runner,
      packageSource,
      environment,
      artifactPaths: [...params.artifactPaths],
      status: result.status,
      ...(failureForScenario(result) ? { failure: failureForScenario(result) } : {}),
      ...(timingForScenario(result) ? { timing: timingForScenario(result) } : {}),
    };
  });
  return buildQaEvidenceSummary({ generatedAt: params.generatedAt, entries });
}

export function buildLiveTransportEvidenceSummary(
  params: QaEvidenceBuildBase & {
    scenarioDefinitions: readonly {
      id: string;
      standardId?: string;
      title: string;
    }[];
    scenarios: readonly QaEvidenceScenarioResultInput[];
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
  const definitionsById = new Map(
    params.scenarioDefinitions.map((definition) => [definition.id, definition]),
  );
  const entries = params.scenarios.map((result, index): QaEvidenceSummaryEntry => {
    const scenarioId = result.id ?? result.name ?? `scenario-${index + 1}`;
    const definition = definitionsById.get(scenarioId);
    const standardCoverageId = definition?.standardId
      ? `channels.${params.transportId}.${definition.standardId}`
      : undefined;
    return {
      scenarioId,
      scenarioTitle: definition?.title ?? result.title ?? result.name ?? scenarioId,
      coverageIds: uniqueSortedStrings([`channels.${params.transportId}.live`, standardCoverageId]),
      scorecard: {
        surfaceIds: [`channels.${params.transportId}`],
        categoryIds: [`channels.${params.transportId}.live`],
      },
      profile,
      ...provider,
      channel: {
        id: params.transportId,
      },
      channel_live: true,
      channel_driver: channelDriver.id,
      runner,
      packageSource,
      environment,
      artifactPaths: [...params.artifactPaths],
      status: result.status,
      ...(failureForScenario(result) ? { failure: failureForScenario(result) } : {}),
      ...(timingForScenario(result) ? { timing: timingForScenario(result) } : {}),
    };
  });
  return buildQaEvidenceSummary({ generatedAt: params.generatedAt, entries });
}
