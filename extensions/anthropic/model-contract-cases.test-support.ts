import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";

type Claude5ContractCase = {
  defaultLevel?: "medium" | "high";
  name: string;
  modelId: string;
  cost: ProviderRuntimeModel["cost"];
  thinkingLevelMap: Record<string, string>;
  thinkingLevels: readonly string[];
  checksMedia?: boolean;
  restoresMissingCost?: boolean | "tiers";
  checksCliPolicy?: boolean;
};

const optionalThinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
];
const mandatoryThinkingLevels = ["low", "medium", "high", "xhigh", "max"];

export const claude5ContractCases: Claude5ContractCase[] = [
  ...["claude-haiku-5-5", "haiku", "haiku-5.5", "haiku-5-5"].map<Claude5ContractCase>(
    (modelId) => ({
      name: `resolves ${modelId} with its adaptive thinking and tiered pricing contract`,
      defaultLevel: "medium" as const,
      modelId,
      cost: {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        tieredPricing: [
          {
            range: [0, 100001],
            input: 0.1,
            output: 0.5,
            cacheRead: 0.01,
            cacheWrite: 0.125,
          },
          {
            range: [100001],
            input: 0.5,
            output: 2.5,
            cacheRead: 0.05,
            cacheWrite: 0.625,
          },
        ],
      },
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      checksMedia: true,
      restoresMissingCost: "tiers" as const,
    }),
  ),
  ...["claude-sonnet-5-5", "sonnet", "sonnet-5.5", "sonnet-5-5"].map((modelId) => ({
    name: `resolves ${modelId} with its between-tools thinking contract`,
    defaultLevel: "high" as const,
    modelId,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    checksMedia: true,
    restoresMissingCost: true,
  })),
  ...["claude-opus-5-5", "opus", "opus-5.5", "opus-5-5"].map((modelId) => ({
    name: `resolves ${modelId} with its always-adaptive API contract`,
    defaultLevel: "medium" as const,
    modelId,
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    thinkingLevels: mandatoryThinkingLevels,
    checksMedia: true,
    restoresMissingCost: true,
  })),
  ...["claude-opus-5", "opus-5"].map((modelId) => ({
    name: `resolves ${modelId} with its exact API contract`,
    modelId,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    thinkingLevels: optionalThinkingLevels,
    checksMedia: true,
    restoresMissingCost: true,
  })),
  {
    name: "resolves Claude Fable 5 with its always-adaptive model contract",
    defaultLevel: "medium",
    modelId: "claude-fable-5",
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    thinkingLevels: mandatoryThinkingLevels,
    checksMedia: true,
    checksCliPolicy: true,
  },
  {
    name: "resolves Claude Fable 5.1 with its always-adaptive model contract",
    defaultLevel: "medium",
    modelId: "claude-fable-5-1",
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    thinkingLevels: mandatoryThinkingLevels,
    checksMedia: true,
    restoresMissingCost: true,
    checksCliPolicy: true,
  },
  {
    name: "resolves Claude Sonnet 5 with its exact API contract",
    modelId: "claude-sonnet-5",
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    thinkingLevels: optionalThinkingLevels,
    restoresMissingCost: true,
  },
];

const requireRecord = createRequireRecord("object", "expected-label");

export function createModelRegistry(models: ProviderRuntimeModel[]) {
  return {
    find(providerId: string, modelId: string) {
      return (
        models.find(
          (model) =>
            model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
        ) ?? null
      );
    },
  };
}

export function expectFields(value: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(value, "record");
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
}

export function levelIds(profile: unknown): Array<unknown> {
  const levels = requireRecord(profile, "thinking profile").levels;
  expect(Array.isArray(levels), "thinking levels").toBe(true);
  return (levels as Array<{ id?: unknown }>).map((level) => level.id);
}
