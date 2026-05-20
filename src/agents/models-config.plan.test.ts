import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planOpenClawModelsJsonWithDeps } from "./models-config.plan.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
  normalizeProviderConfigWithPlugin: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

async function planGeneratedProviders(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
}) {
  const plan = await planOpenClawModelsJsonWithDeps(
    {
      cfg: params.config,
      sourceConfigForSecrets: params.sourceConfigForSecrets ?? params.config,
      agentDir: "/tmp/openclaw-models-plan",
      env: {},
      existingRaw: "",
      existingParsed: null,
    },
    {
      resolveImplicitProviders: async () => ({}),
    },
  );
  expect(plan.action).toBe("write");
  if (plan.action !== "write") {
    throw new Error(`expected models.json write plan, got ${plan.action}`);
  }
  return JSON.parse(plan.contents).providers as Record<string, { apiKey?: string }>;
}

describe("models-config plan", () => {
  it("strips plaintext provider api keys from generated models.json", async () => {
    const providers = await planGeneratedProviders({
      config: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example/v1",
              api: "openai-completions",
              apiKey: "sk-runtime-custom-key", // pragma: allowlist secret
              models: [],
            },
          },
        },
      },
    });

    expect(providers.custom?.apiKey).toBeUndefined();
  });

  it("keeps provider api key markers in generated models.json", async () => {
    const providers = await planGeneratedProviders({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-completions",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      },
    });

    expect(providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
  });
});
