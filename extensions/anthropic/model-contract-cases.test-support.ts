type Claude5ContractCase = {
  defaultLevel?: "medium" | "high";
  name: string;
  modelId: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap: Record<string, string>;
  checksMedia?: boolean;
  restoresMissingCost?: boolean;
  checksCliPolicy?: boolean;
};

export const claude5ContractCases: Claude5ContractCase[] = [
  ...["claude-opus-5-5", "opus", "opus-5.5", "opus-5-5"].map((modelId) => ({
    name: `resolves ${modelId} with its always-adaptive API contract`,
    defaultLevel: "medium" as const,
    modelId,
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    checksMedia: true,
    restoresMissingCost: true,
  })),
  ...["claude-opus-5", "opus-5"].map((modelId) => ({
    name: `resolves ${modelId} with its exact API contract`,
    modelId,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    checksMedia: true,
    restoresMissingCost: true,
  })),
  {
    name: "resolves Claude Fable 5 with its always-adaptive model contract",
    defaultLevel: "medium",
    modelId: "claude-fable-5",
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    checksMedia: true,
    checksCliPolicy: true,
  },
  {
    name: "resolves Claude Fable 5.1 with its always-adaptive model contract",
    defaultLevel: "medium",
    modelId: "claude-fable-5-1",
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    checksMedia: true,
    restoresMissingCost: true,
    checksCliPolicy: true,
  },
  {
    name: "resolves Claude Sonnet 5 with its exact API contract",
    modelId: "claude-sonnet-5",
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    restoresMissingCost: true,
  },
];
