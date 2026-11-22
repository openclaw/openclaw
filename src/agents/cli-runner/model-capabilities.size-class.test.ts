import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentProfile } from "../agent-profiles.js";
import { resolveCliModelCapabilities } from "./model-capabilities.js";

function configuredConfig(modelSizeClass: "small" | undefined): OpenClawConfig {
  return {
    models: {
      providers: {
        "llama-cpp": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          models: [
            {
              id: "local-8b",
              name: "Local 8B",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 4_096,
              ...(modelSizeClass ? { modelSizeClass } : {}),
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

function resolve(config: OpenClawConfig) {
  return resolveCliModelCapabilities({
    run: { config, provider: "llama-cpp" },
    runConfig: config,
    workspaceDir: "/tmp/openclaw-size-class-test",
    backend: { id: "test-cli", modelProvider: "llama-cpp" },
    modelId: "local-8b",
    normalizedModel: "local-8b",
    contextModelIds: ["local-8b"],
  });
}

describe("resolveCliModelCapabilities size class from a configured model row", () => {
  it("carries a configured modelSizeClass without a parameter count", () => {
    expect(resolve(configuredConfig("small")).modelSizeClass).toBe("small");
  });

  it("lets agentProfileId auto select openclaw/small from a configured row with no parameter count", () => {
    const config = configuredConfig("small");
    config.agents = { defaults: { agentProfileId: "auto" } };
    const { modelSizeClass } = resolve(config);

    const resolved = resolveAgentProfile({ config, agentId: "main", modelSizeClass });
    expect(resolved.profile.id).toBe("openclaw/small");
    expect(resolved.selectionSource).toBe("model-size");
  });

  it("leaves the size class unset when the row does not configure one", () => {
    expect(resolve(configuredConfig(undefined)).modelSizeClass).toBeUndefined();
  });
});
