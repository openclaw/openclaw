import { describe, expect, it } from "vitest";
import { applyAgentBrainTierPatch, applyGlobalBrainTierPatch } from "./brain-config-patch.js";
import { normalizeBrainTierConfigParts } from "./brain-profiles.js";

type PatchedAgentsConfig = {
  agents: {
    defaults: {
      model?: unknown;
      models: Record<string, unknown>;
    };
    list: Array<Record<string, unknown>>;
  };
};

describe("brain config patch helpers", () => {
  it("patches global default model, agent strings, and profile params", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "openai-codex-subscription-best" },
    });
    const next = applyGlobalBrainTierPatch(
      {
        agents: {
          defaults: { model: "anthropic/claude-haiku-4-5-20251001", models: {} },
          list: [{ id: "quinn", model: "anthropic/claude-haiku-4-5-20251001" }],
        },
      },
      "einstein",
      tierConfig,
    ) as PatchedAgentsConfig;

    expect(next.agents.defaults.model).toBe("openai-codex/gpt-5.5");
    expect(next.agents.defaults.models["openai-codex/gpt-5.5"]).toMatchObject({
      params: { reasoning_effort: "high" },
    });
    expect(next.agents.list[0].model).toBe("openai-codex/gpt-5.5");
  });

  it("clears stale object fallbacks when the resolved profile has none", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      tierRouting: { baller: "openai-api-balanced" },
    });
    const next = applyGlobalBrainTierPatch(
      {
        agents: {
          defaults: {},
          list: [
            {
              id: "quinn",
              model: { primary: "anthropic/claude-haiku-4-5-20251001", fallbacks: ["x/y"] },
            },
          ],
        },
      },
      "baller",
      tierConfig,
    ) as PatchedAgentsConfig;

    expect(next.agents.list[0].model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: [],
    });
  });

  it("writes profile fallbacks for string-form agent models", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "codex-with-local-fallback" },
      brainProfiles: {
        "codex-with-local-fallback": {
          id: "codex-with-local-fallback",
          label: "Codex with local fallback",
          provider: "openai-codex",
          model: "gpt-5.5",
          auth: "oauth",
          billing: "subscription",
          modelRef: "openai-codex/gpt-5.5",
          fallbacks: ["local-economy"],
          allowMeteredFallback: false,
          commercialSafe: false,
        },
      },
    });

    const next = applyGlobalBrainTierPatch(
      {
        agents: {
          defaults: {},
          list: [{ id: "quinn", model: "anthropic/claude-haiku-4-5-20251001" }],
        },
      },
      "einstein",
      tierConfig,
    ) as PatchedAgentsConfig;

    expect(next.agents.defaults.model).toEqual({
      primary: "openai-codex/gpt-5.5",
      fallbacks: ["local-openai-compatible/local-default"],
    });
    expect(next.agents.list[0].model).toEqual({
      primary: "openai-codex/gpt-5.5",
      fallbacks: ["local-openai-compatible/local-default"],
    });
  });

  it("uses agent override when globally patching agent list", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      agentOverrides: { quinn: "einstein" },
      tierRouting: {
        baller: "openai-api-balanced",
        einstein: "openai-codex-subscription-best",
      },
    });
    const next = applyGlobalBrainTierPatch(
      { agents: { defaults: {}, list: [{ id: "quinn" }, { id: "main" }] } },
      "baller",
      tierConfig,
    ) as PatchedAgentsConfig;

    expect(next.agents.list[0].model).toBe("openai-codex/gpt-5.5");
    expect(next.agents.list[1].model).toBe("openai/gpt-5.4");
  });

  it("patches one agent override and inserts missing agent entries", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "openai-codex-subscription-best" },
    });

    const next = applyAgentBrainTierPatch(
      { agents: { defaults: {}, list: [] } },
      "new-agent",
      "einstein",
      tierConfig,
    ) as PatchedAgentsConfig;

    expect(next.agents.list).toEqual([{ id: "new-agent", model: "openai-codex/gpt-5.5" }]);
  });

  it("clears explicit model when an agent returns to inherit", () => {
    const tierConfig = normalizeBrainTierConfigParts({});

    const next = applyAgentBrainTierPatch(
      { agents: { defaults: {}, list: [{ id: "quinn", model: "openai-codex/gpt-5.5" }] } },
      "quinn",
      "inherit",
      tierConfig,
    ) as PatchedAgentsConfig;

    expect(next.agents.list[0]).toEqual({ id: "quinn" });
  });
});
