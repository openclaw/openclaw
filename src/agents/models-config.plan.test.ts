import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { planOpenClawModelsJsonWithDeps } from "./models-config.plan.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
  normalizeProviderConfigWithPlugin: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

function customModelConfig() {
  return {
    id: "custom-model",
    name: "Custom Model",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

async function planGeneratedContents(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
  existingParsed?: unknown;
}): Promise<string> {
  const plan = await planOpenClawModelsJsonWithDeps(
    {
      cfg: params.config,
      sourceConfigForSecrets: params.sourceConfigForSecrets ?? params.config,
      agentDir: "/tmp/openclaw-models-plan",
      env: {},
      existingRaw: "",
      existingParsed: params.existingParsed ?? null,
    },
    {
      resolveImplicitProviders: async () => ({}),
    },
  );
  expect(plan.action).toBe("write");
  if (plan.action !== "write") {
    throw new Error(`expected models.json write plan, got ${plan.action}`);
  }
  return plan.contents;
}

async function planGeneratedProviders(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
  existingParsed?: unknown;
}) {
  const contents = await planGeneratedContents(params);
  return JSON.parse(contents).providers as Record<string, { apiKey?: string }>;
}

describe("models-config plan", () => {
  it("replaces plaintext custom model provider api keys with a pi-compatible marker", async () => {
    const providers = await planGeneratedProviders({
      config: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example/v1",
              api: "openai-completions",
              apiKey: "sk-runtime-custom-key", // pragma: allowlist secret
              models: [customModelConfig()],
            },
          },
        },
      },
    });

    expect(providers.custom?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
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

  it("strips existing models.json-only provider api keys in merge mode", async () => {
    const providers = await planGeneratedProviders({
      config: {
        models: {
          mode: "merge",
          providers: {
            custom: {
              baseUrl: "https://custom.example/v1",
              api: "openai-completions",
              models: [customModelConfig()],
            },
          },
        },
      },
      existingParsed: {
        providers: {
          custom: {
            baseUrl: "https://custom.example/v1",
            api: "openai-completions",
            apiKey: "sk-existing-models-json-only", // pragma: allowlist secret
            models: [customModelConfig()],
          },
        },
      },
    });

    expect(providers.custom?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it("keeps custom provider models discoverable after stripping plaintext api keys", async () => {
    const contents = await planGeneratedContents({
      config: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://custom.example/v1",
              api: "openai-completions",
              apiKey: "sk-runtime-custom-key", // pragma: allowlist secret
              models: [customModelConfig()],
            },
          },
        },
      },
    });
    const parsed = JSON.parse(contents) as { providers: Record<string, { apiKey?: string }> };
    expect(parsed.providers.custom?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(contents).not.toContain("sk-runtime-custom-key");

    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-models-plan-"));
    fs.writeFileSync(path.join(agentDir, "models.json"), contents);

    const authStorage = discoverAuthStorage(agentDir, { skipCredentials: true });
    const registry = discoverModels(authStorage, agentDir, { normalizeModels: false });

    expect(registry.find("custom", "custom-model")?.id).toBe("custom-model");
  });
});
