import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { appendPrioritizedDynamicLiveModels } from "./live-model-dynamic-candidates.js";

vi.mock("./agent-model-discovery.js", () => ({
  normalizeDiscoveredAgentModel: <T>(value: T) => value,
}));

const REGISTRY = { find: () => undefined } as never;
type DynamicModelResolver = NonNullable<
  Parameters<typeof appendPrioritizedDynamicLiveModels>[0]["resolveDynamicModel"]
>;
type DynamicModelPreparer = NonNullable<
  Parameters<typeof appendPrioritizedDynamicLiveModels>[0]["prepareDynamicModel"]
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
    const resolveDynamicModel: DynamicModelResolver = vi.fn((params) =>
      params.context.provider === "opencode-go" && params.context.modelId === "glm-5"
        ? model("opencode-go", "glm-5")
        : undefined,
    );
    const prepareDynamicModel: DynamicModelPreparer = vi.fn(async () => undefined);
    const config = {
      models: {
        providers: {
          "opencode-go": {
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
      refs: [
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "opencode-go", id: "glm-5" },
      ],
    });

    expect(result.added.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "opencode-go/glm-5",
    ]);
    expect(result.models.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "opencode-go/glm-5",
    ]);
    expect(prepareDynamicModel).toHaveBeenCalledTimes(1);
    expect(prepareDynamicModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode-go",
        context: expect.objectContaining({
          agentDir: "/tmp/openclaw-agent",
          modelId: "glm-5",
          modelRegistry: REGISTRY,
          provider: "opencode-go",
          providerConfig: config.models?.providers?.["opencode-go"],
        }),
      }),
    );
    expect(resolveDynamicModel).toHaveBeenCalledTimes(1);
    expect(resolveDynamicModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode-go",
        context: expect.objectContaining({
          agentDir: "/tmp/openclaw-agent",
          modelId: "glm-5",
          modelRegistry: REGISTRY,
          provider: "opencode-go",
          providerConfig: config.models?.providers?.["opencode-go"],
        }),
      }),
    );
  });

  it("does not duplicate refs already present in the generated registry", async () => {
    const resolveDynamicModel: DynamicModelResolver = vi.fn(() => model("opencode-go", "glm-5"));
    const prepareDynamicModel: DynamicModelPreparer = vi.fn(async () => undefined);

    const result = await appendPrioritizedDynamicLiveModels({
      models: [model("opencode-go", "glm-5")],
      agentDir: "/tmp/openclaw-agent",
      modelRegistry: REGISTRY,
      resolveDynamicModel,
      prepareDynamicModel,
      refs: [{ provider: "opencode-go", id: "glm-5" }],
    });

    expect(result.added).toEqual([]);
    expect(result.models).toHaveLength(1);
    expect(prepareDynamicModel).not.toHaveBeenCalled();
    expect(resolveDynamicModel).not.toHaveBeenCalled();
  });
});
