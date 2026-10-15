// Anthropic tests cover provider policy api plugin behavior.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { parseAnthropicModelRef } from "./claude-model-refs.js";
import {
  applyConfigDefaults,
  deprecatedProfileIds,
  normalizeConfig,
  resolveProactiveCadenceMs,
  resolveThinkingProfile,
} from "./provider-policy-api.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const modelRefCases: Array<[string, string | null, string | null, boolean | null]> = [
  ["", null, null, null],
  ["claude-test", "anthropic", "claude-test", false],
  ["anthropic/", null, null, null],
  ["AWS-BEDROCK/anthropic.claude-test", "amazon-bedrock", "anthropic.claude-test", true],
];

describe("anthropic provider policy public artifact", () => {
  it.each([
    ["oauth", 3_600_000],
    ["token", 3_600_000],
    ["api_key", 1_800_000],
  ] as const)("resolves %s proactive cadence without adding heartbeat config", (mode, cadence) => {
    const config = {
      auth: { profiles: { default: { provider: "anthropic", mode } } },
      agents: { defaults: {} },
    };
    expect(resolveProactiveCadenceMs({ config, env: {} })).toBe(cadence);
    expect(applyConfigDefaults({ config, env: {} }).agents?.defaults).not.toHaveProperty(
      "heartbeat",
    );
  });

  it("leaves proactive cadence unset without Anthropic credentials", () => {
    expect(resolveProactiveCadenceMs({ config: {}, env: {} })).toBeUndefined();
  });

  it.each(modelRefCases)(
    "parses Anthropic model ref %s",
    (raw, provider, model, explicitProvider) => {
      expect(parseAnthropicModelRef(raw)).toEqual(
        provider === null ? null : { provider, model, explicitProvider },
      );
    },
  );

  it("publishes native Claude profiles retired from generic auth", () => {
    expect(deprecatedProfileIds).toEqual(["anthropic:claude-cli"]);
  });

  it("normalizes Claude CLI provider config", () => {
    const normalized = normalizeConfig({
      provider: "claude-cli",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
      },
    });
    expect(normalized.api).toBe("anthropic-messages");
  });

  it("does not normalize non-Anthropic provider config", () => {
    const providerConfig = {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: [createModel("gpt-5.4", "GPT-5.4")],
    };

    expect(
      normalizeConfig({
        provider: "openai",
        providerConfig,
      }),
    ).toBe(providerConfig);
  });

  it("applies Anthropic API-key defaults without loading the full provider plugin", () => {
    const nextConfig = applyConfigDefaults({
      config: {
        auth: {
          profiles: {
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
          order: { anthropic: ["anthropic:default"] },
        },
        agents: {
          defaults: {},
        },
      },
      env: {},
    });

    expect(nextConfig.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
    expect(nextConfig.agents?.defaults?.contextPruning?.ttl).toBe("1h");
  });

  it("adds cacheRetention defaults for dated Anthropic primary model refs", () => {
    const nextConfig = applyConfigDefaults({
      config: {
        auth: {
          profiles: {
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-20250514" },
          },
        },
      },
      env: {},
    });

    expect(
      nextConfig.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it.each(["claude-sonnet-5-5"])(
    "keeps the %s thinking profile identical across API and CLI routes",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "claude-cli", modelId })).toEqual(
        resolveThinkingProfile({ provider: "anthropic", modelId }),
      );
    },
  );

  it("keeps direct-only Mythos thinking disabled on the CLI route", () => {
    expect(resolveThinkingProfile({ provider: "claude-cli", modelId: "claude-mythos-5" })).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });

  it("does not expose Anthropic thinking profiles for unrelated providers", () => {
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "claude-opus-4-7",
      }),
    ).toBeNull();
  });
});
