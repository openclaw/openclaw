import {
  asBoolean as readBoolean,
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

export type QaRuntimeToolBucket = (typeof QA_RUNTIME_TOOL_BUCKETS)[number];

export type QaRuntimeToolExpectedLayer = (typeof QA_RUNTIME_TOOL_EXPECTED_LAYERS)[number];

export type QaRuntimeCapabilityLayer = (typeof QA_RUNTIME_CAPABILITY_LAYERS)[number];

export type RuntimeParityComparisonMode = "default" | "codex-native-workspace" | "outcome-only";

export type QaRuntimeToolCoverageMetadata = {
  bucket: QaRuntimeToolBucket;
  expectedLayer: QaRuntimeToolExpectedLayer;
  capabilityLayer: QaRuntimeCapabilityLayer;
  required: boolean;
  tracking?: string;
  reason?: string;
  codexDefaultImpact?: string;
  qaImpact?: string;
  action?: string;
};

const QA_RUNTIME_TOOL_BUCKETS = [
  "codex-native-workspace",
  "openclaw-dynamic-integration",
  "optional-profile-or-plugin",
] as const;

const QA_RUNTIME_TOOL_EXPECTED_LAYERS = [
  "codex-native-workspace",
  "openclaw-dynamic",
  "profile-or-plugin",
] as const;

const QA_RUNTIME_CAPABILITY_LAYERS = [
  "codex-native-workspace",
  "openclaw-dynamic-direct",
  "openclaw-dynamic-searchable",
  "optional-profile-or-plugin",
  "structural-text",
] as const;

const DEFAULT_LAYER_BY_BUCKET: Record<QaRuntimeToolBucket, QaRuntimeToolExpectedLayer> = {
  "codex-native-workspace": "codex-native-workspace",
  "openclaw-dynamic-integration": "openclaw-dynamic",
  "optional-profile-or-plugin": "profile-or-plugin",
};

const DEFAULT_CAPABILITY_LAYER_BY_BUCKET: Record<QaRuntimeToolBucket, QaRuntimeCapabilityLayer> = {
  "codex-native-workspace": "codex-native-workspace",
  "openclaw-dynamic-integration": "openclaw-dynamic-searchable",
  "optional-profile-or-plugin": "optional-profile-or-plugin",
};

function readRuntimeToolEnum<T extends string>(
  input: unknown,
  values: readonly T[],
  fallback: T,
  label: string,
): T {
  const value = readString(input);
  if (!value) {
    return fallback;
  }
  const selected = values.find((candidate) => candidate === value);
  if (selected === undefined) {
    throw new Error(`unknown runtime tool ${label}: ${value}; expected ${values.join(", ")}`);
  }
  return selected;
}

export function readRuntimeToolCoverageConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return isRecord(config?.toolCoverage) ? config.toolCoverage : undefined;
}

export function readRuntimeToolCoverageMetadata(params: {
  config?: Record<string, unknown>;
}): QaRuntimeToolCoverageMetadata {
  const toolCoverage = readRuntimeToolCoverageConfig(params.config);
  const bucket = readRuntimeToolEnum(
    toolCoverage?.bucket,
    QA_RUNTIME_TOOL_BUCKETS,
    params.config?.expectedAvailable === false
      ? "optional-profile-or-plugin"
      : "openclaw-dynamic-integration",
    "coverage bucket",
  );
  const expectedLayer = readRuntimeToolEnum(
    toolCoverage?.expectedLayer,
    QA_RUNTIME_TOOL_EXPECTED_LAYERS,
    DEFAULT_LAYER_BY_BUCKET[bucket],
    "expectedLayer",
  );
  const capabilityLayer = readRuntimeToolEnum(
    toolCoverage?.capabilityLayer,
    QA_RUNTIME_CAPABILITY_LAYERS,
    DEFAULT_CAPABILITY_LAYER_BY_BUCKET[bucket],
    "capabilityLayer",
  );
  const explicitSearchableDynamic =
    readString(toolCoverage?.capabilityLayer) === "openclaw-dynamic-searchable";
  const required =
    readBoolean(toolCoverage?.required) ??
    (bucket !== "optional-profile-or-plugin" && !explicitSearchableDynamic);
  return {
    bucket,
    expectedLayer,
    capabilityLayer,
    required,
    ...((readString(toolCoverage?.tracking) ?? readString(toolCoverage?.issue))
      ? { tracking: readString(toolCoverage?.tracking) ?? readString(toolCoverage?.issue) }
      : {}),
    ...(readString(toolCoverage?.reason) ? { reason: readString(toolCoverage?.reason) } : {}),
    ...(readString(toolCoverage?.codexDefaultImpact)
      ? { codexDefaultImpact: readString(toolCoverage?.codexDefaultImpact) }
      : {}),
    ...(readString(toolCoverage?.qaImpact) ? { qaImpact: readString(toolCoverage?.qaImpact) } : {}),
    ...(readString(toolCoverage?.action) ? { action: readString(toolCoverage?.action) } : {}),
  };
}

export function readScenarioRuntimeToolCoverageMetadata(
  scenario: QaSeedScenarioWithSource,
): QaRuntimeToolCoverageMetadata {
  return readRuntimeToolCoverageMetadata({
    config: scenario.execution.config,
  });
}
