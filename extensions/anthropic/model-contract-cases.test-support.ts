import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
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

const mandatoryThinkingLevels = ["low", "medium", "high", "xhigh", "max"];
const haikuCost = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
const commonContract = {
  thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
  checksMedia: true,
  restoresMissingCost: true,
};

export const claude5ContractCases: Claude5ContractCase[] = [
  {
    ...commonContract,
    name: "resolves claude-haiku-5-5 with its adaptive thinking and tiered pricing contract",
    defaultLevel: "medium",
    modelId: "claude-haiku-5-5",
    cost: {
      ...haikuCost,
      tieredPricing: [
        { range: [0, 100001], ...haikuCost },
        { range: [100001], input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
      ],
    },
    thinkingLevels: ["off", ...mandatoryThinkingLevels],
    restoresMissingCost: "tiers",
  },
  {
    ...commonContract,
    name: "resolves opus-5 with its exact API contract",
    modelId: "opus-5",
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    thinkingLevels: "off minimal low medium high xhigh adaptive max".split(" "),
  },
  {
    ...commonContract,
    name: "resolves Claude Fable 5.1 with its always-adaptive model contract",
    defaultLevel: "medium",
    modelId: "claude-fable-5-1",
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    thinkingLevels: mandatoryThinkingLevels,
    checksCliPolicy: true,
  },
];

const requireRecord = createRequireRecord("object", "expected-label");

type TestModel = ProviderRuntimeModel & {
  api: "anthropic-messages";
  headers?: Record<string, string>;
};
export function makeModel(id: string, overrides: Partial<TestModel> = {}): TestModel {
  return {
    id,
    name: id,
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  };
}

export function createModelRegistry(
  models: ProviderRuntimeModel[],
): ProviderResolveDynamicModelContext["modelRegistry"] {
  return {
    getAll: () => models,
    getAvailable: () => models,
    hasConfiguredAuth: () => true,
    find: (providerId: string, modelId: string) =>
      models.find(
        (model) =>
          model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
      ),
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
