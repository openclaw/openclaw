import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

function minimalConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return { ...overrides } as OpenClawConfig;
}

describe("resolveModelRuntimePolicy", () => {
  it("returns empty when no runtime policy is configured anywhere", () => {
    const result = resolveModelRuntimePolicy({
      config: minimalConfig(),
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(result.policy).toBeUndefined();
  });

  it("returns agents.defaults.agentRuntime as fallback when no model or provider runtime is set", () => {
    const config = minimalConfig({
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
    });
    const result = resolveModelRuntimePolicy({
      config,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(result.policy).toEqual({ id: "claude-cli" });
  });

  it("prefers provider-level agentRuntime over agents.defaults.agentRuntime", () => {
    const config = minimalConfig({
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
      models: {
        providers: {
          anthropic: {
            agentRuntime: { id: "embedded" },
            models: [],
          },
        },
      },
    });
    const result = resolveModelRuntimePolicy({
      config,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(result.policy).toEqual({ id: "embedded" });
    expect(result.source).toBe("provider");
  });

  it("prefers model-level agentRuntime over agents.defaults.agentRuntime", () => {
    const config = minimalConfig({
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
          models: {
            "anthropic/claude-sonnet-4-6": {
              agentRuntime: { id: "model-specific" },
            },
          },
        },
      },
    });
    const result = resolveModelRuntimePolicy({
      config,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(result.policy).toEqual({ id: "model-specific" });
    expect(result.source).toBe("model");
  });
});
