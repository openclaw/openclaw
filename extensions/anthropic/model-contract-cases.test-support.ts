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
  {
    name: "resolves claude-haiku-5-5 with its adaptive thinking and tiered pricing contract",
    defaultLevel: "medium",
    modelId: "claude-haiku-5-5",
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tieredPricing: [
        { range: [0, 100001], input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
        { range: [100001], input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
      ],
    },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    checksMedia: true,
    restoresMissingCost: "tiers",
  },
  {
    name: "resolves opus-5 with its exact API contract",
    modelId: "opus-5",
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    thinkingLevels: optionalThinkingLevels,
    checksMedia: true,
    restoresMissingCost: true,
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
