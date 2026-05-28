import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";

vi.mock("./agent-model-discovery.js", () => ({
  normalizeDiscoveredAgentModel: (value: unknown) => value,
}));

import { appendPrioritizedDynamicLiveModels } from "./live-model-dynamic-candidates.js";

const REGISTRY = { find: () => undefined } as never;
const DYNAMIC_PROVIDER = "dynamic-test-provider";
type DynamicModelResolver = NonNullable<
  Parameters<typeof appendPrioritizedDynamicLiveModels>[0]["resolveDynamicModel"]
>;
type DynamicModelPreparer = NonNullable<
  Parameters<typeof appendPrioritizedDynamicLiveModels>[0]["prepareDynamicModel"]
>;
type DynamicModelNormalizer = NonNullable<
  Parameters<typeof appendPrioritizedDynamicLiveModels>[0]["normalizeModel"]
>;

function model(provider: string, id: string): Model {
  return {
    id,
    name: id,
    provider,
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

describe("appendPrioritizedDynamicLiveModels", () => {
  it("materializes prioritized refs from provider dynamic model hooks", async () => {
    const resolveCalls: Parameters<DynamicModelResolver>[] = [];
    const prepareCalls: Parameters<DynamicModelPreparer>[] = [];
    const normalizeCalls: Array<[Model, string]> = [];
    const resolveDynamicModel: DynamicModelResolver = (params) => {
      resolveCalls.push([params]);
      return params.context.provider === DYNAMIC_PROVIDER && params.context.modelId === "glm-5"
        ? model(DYNAMIC_PROVIDER, "glm-5")
        : undefined;
    };
    const prepareDynamicModel: DynamicModelPreparer = async (params) => {
      prepareCalls.push([params]);
    };
    const normalizeModel: DynamicModelNormalizer = (entry, agentDir) => {
      normalizeCalls.push([entry, agentDir]);
      return entry;
    };
    const config = {
      models: {
        providers: {
          [DYNAMIC_PROVIDER]: {
            api: "openai-completions",
            baseUrl: "https://configured.example/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = await appendPrioritizedDynamicLiveModels({
      models: [model("anthropic", "claude-sonnet-4-6")],
      config,
      agentDir: "/tmp/openclaw-agent",
      modelRegistry: REGISTRY,
      resolveDynamicModel,
      prepareDynamicModel,
      normalizeModel,
      refs: [
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: DYNAMIC_PROVIDER, id: "glm-5" },
      ],
    });

    expect(result.added.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      `${DYNAMIC_PROVIDER}/glm-5`,
    ]);
    expect(result.models.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
      `${DYNAMIC_PROVIDER}/glm-5`,
    ]);
    expect(prepareCalls).toHaveLength(1);
    const prepareParam = prepareCalls[0]?.[0];
    expect(prepareParam?.provider).toBe(DYNAMIC_PROVIDER);
    expect(prepareParam?.context.agentDir).toBe("/tmp/openclaw-agent");
    expect(prepareParam?.context.modelId).toBe("glm-5");
    expect(prepareParam?.context.modelRegistry).toBe(REGISTRY);
    expect(prepareParam?.context.provider).toBe(DYNAMIC_PROVIDER);
    expect(prepareParam?.context.providerConfig).toBe(
      config.models?.providers?.[DYNAMIC_PROVIDER],
    );
    expect(resolveCalls).toHaveLength(1);
    const resolveParam = resolveCalls[0]?.[0];
    expect(resolveParam?.provider).toBe(DYNAMIC_PROVIDER);
    expect(resolveParam?.context.agentDir).toBe("/tmp/openclaw-agent");
    expect(resolveParam?.context.modelId).toBe("glm-5");
    expect(resolveParam?.context.modelRegistry).toBe(REGISTRY);
    expect(resolveParam?.context.provider).toBe(DYNAMIC_PROVIDER);
    expect(resolveParam?.context.providerConfig).toBe(
      config.models?.providers?.[DYNAMIC_PROVIDER],
    );
    expect(normalizeCalls).toHaveLength(1);
    const normalizeParam = normalizeCalls[0];
    expect(normalizeParam?.[0].provider).toBe(DYNAMIC_PROVIDER);
    expect(normalizeParam?.[0].id).toBe("glm-5");
    expect(normalizeParam?.[1]).toBe("/tmp/openclaw-agent");
  });

  it("does not duplicate refs already present in the generated registry", async () => {
    const resolveDynamicModel: DynamicModelResolver = vi.fn(() => model(DYNAMIC_PROVIDER, "glm-5"));
    const prepareDynamicModel: DynamicModelPreparer = vi.fn(async () => undefined);

    const result = await appendPrioritizedDynamicLiveModels({
      models: [model(DYNAMIC_PROVIDER, "glm-5")],
      agentDir: "/tmp/openclaw-agent",
      modelRegistry: REGISTRY,
      resolveDynamicModel,
      prepareDynamicModel,
      refs: [{ provider: DYNAMIC_PROVIDER, id: "glm-5" }],
    });

    expect(result.added).toEqual([]);
    expect(result.models).toHaveLength(1);
    expect(prepareDynamicModel).not.toHaveBeenCalled();
    expect(resolveDynamicModel).not.toHaveBeenCalled();
  });
});
