import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { OPENCLAW_MANAGED_AUTH_MARKER } from "./model-auth-markers.js";
import { unsetEnv, withTempEnv } from "./models-config.e2e-harness.js";
import {
  planOpenClawModelsJsonWithDeps,
  resolveProvidersForModelsJsonWithDeps,
} from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const TEST_ENV_VAR = "OPENCLAW_MODELS_CONFIG_TEST_ENV";

function createImplicitOpenRouterProvider(): ProviderConfig {
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    apiKey: "OPENROUTER_API_KEY",
    models: [
      {
        id: "openrouter/auto",
        name: "OpenRouter Auto",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };
}

function createTestModel(
  id = "custom-model",
  name = "Custom",
): NonNullable<ProviderConfig["models"]>[number] {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

async function resolveProvidersForConfigEnvTest(params: {
  cfg: OpenClawConfig;
  onResolveImplicitProviders: (env: NodeJS.ProcessEnv) => void;
}) {
  const env = createConfigRuntimeEnv(params.cfg);
  return await resolveProvidersForModelsJsonWithDeps(
    {
      cfg: params.cfg,
      agentDir: "/tmp/openclaw-models-config-env-vars-test",
      env,
    },
    {
      resolveImplicitProviders: async ({ env: discoveryEnv }) => {
        params.onResolveImplicitProviders(discoveryEnv);
        return {
          openrouter: createImplicitOpenRouterProvider(),
        };
      },
    },
  );
}

function createConfigEnvVarsConfig(): OpenClawConfig {
  return {
    models: { providers: {} },
    env: {
      vars: {
        OPENROUTER_API_KEY: "from-config", // pragma: allowlist secret
        [TEST_ENV_VAR]: "from-config",
      },
    },
  };
}

async function resolveProvidersAndCaptureDiscoveryEnv(cfg: OpenClawConfig) {
  let discoveryEnv: NodeJS.ProcessEnv | undefined;
  const providers = await resolveProvidersForConfigEnvTest({
    cfg,
    onResolveImplicitProviders: (env) => {
      discoveryEnv = env;
    },
  });
  return { discoveryEnv, providers };
}

describe("models-config", () => {
  it("threads plugin metadata snapshots into implicit provider discovery", async () => {
    const pluginMetadataSnapshot = {
      index: { plugins: [] },
      manifestRegistry: { plugins: [], diagnostics: [] },
      owners: { providers: new Map() },
    } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    let observedSnapshot:
      | Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">
      | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        pluginMetadataSnapshot,
      },
      {
        resolveImplicitProviders: async ({ pluginMetadataSnapshot: receivedSnapshot }) => {
          observedSnapshot = receivedSnapshot;
          return {};
        },
      },
    );

    expect(observedSnapshot).toBe(pluginMetadataSnapshot);
  });

  it("threads workspace scope into implicit provider discovery", async () => {
    let observedWorkspaceDir: string | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        workspaceDir: "/tmp/openclaw-workspace",
      },
      {
        resolveImplicitProviders: async ({ workspaceDir }) => {
          observedWorkspaceDir = workspaceDir;
          return {};
        },
      },
    );

    expect(observedWorkspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("threads startup provider discovery scope into implicit provider discovery", async () => {
    let observedProviderIds: readonly string[] | undefined;
    let observedEntriesOnly: boolean | undefined;
    let observedTimeoutMs: number | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryEntriesOnly: true,
        providerDiscoveryTimeoutMs: 5000,
      },
      {
        resolveImplicitProviders: async ({
          providerDiscoveryProviderIds,
          providerDiscoveryEntriesOnly,
          providerDiscoveryTimeoutMs,
        }) => {
          observedProviderIds = providerDiscoveryProviderIds;
          observedEntriesOnly = providerDiscoveryEntriesOnly;
          observedTimeoutMs = providerDiscoveryTimeoutMs;
          return {};
        },
      },
    );

    expect(observedProviderIds).toEqual(["openai"]);
    expect(observedEntriesOnly).toBe(true);
    expect(observedTimeoutMs).toBe(5000);
  });

  it("threads plugin metadata snapshots through models.json planning", async () => {
    const pluginMetadataSnapshot = {
      index: { plugins: [] },
      manifestRegistry: { plugins: [], diagnostics: [] },
      owners: { providers: new Map() },
    } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    let observedSnapshot:
      | Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">
      | undefined;

    await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        existingRaw: "",
        existingParsed: null,
        pluginMetadataSnapshot,
      },
      {
        resolveImplicitProviders: async ({ pluginMetadataSnapshot: receivedSnapshot }) => {
          observedSnapshot = receivedSnapshot;
          return {};
        },
      },
    );

    expect(observedSnapshot).toBe(pluginMetadataSnapshot);
  });

  it("normalizes retired Gemini ids preserved from existing models.json rows", async () => {
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { mode: "merge", providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        existingRaw: "",
        existingParsed: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              api: "google-generative-ai",
              apiKey: "GOOGLE_API_KEY", // pragma: allowlist secret
              models: [
                {
                  id: "gemini-3-pro-preview",
                  name: "Gemini 3 Pro",
                  input: ["text"],
                },
              ],
            },
          },
        },
      },
      {
        resolveImplicitProviders: async () => ({
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            apiKey: "OPENAI_API_KEY", // pragma: allowlist secret
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                input: ["text"],
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 400000,
                maxTokens: 128000,
              },
            ],
          },
        }),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    const parsed = JSON.parse(plan.contents) as {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    };
    expect(parsed.providers?.google?.models?.map((model) => model.id)).toEqual([
      "gemini-3.1-pro-preview",
    ]);
  });

  it("serializes a non-secret marker instead of config plaintext provider api keys", async () => {
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://custom.example/v1",
                api: "openai-completions",
                apiKey: "sk-config-plaintext",
                models: [createTestModel()],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
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
      throw new Error("Expected models.json write plan");
    }
    const parsed = JSON.parse(plan.contents) as {
      providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
    };
    expect(parsed.providers?.custom?.baseUrl).toBe("https://custom.example/v1");
    expect(parsed.providers?.custom?.apiKey).toBe(OPENCLAW_MANAGED_AUTH_MARKER);
    expect(plan.contents).not.toContain("sk-config-plaintext");
  });

  it("preserves managed env secret markers while serializing models.json", async () => {
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://custom.example/v1",
                api: "openai-completions",
                apiKey: "${MY_CUSTOM_API_KEY}",
                models: [createTestModel()],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: { MY_CUSTOM_API_KEY: "sk-runtime-custom" } as NodeJS.ProcessEnv,
        existingRaw: "",
        existingParsed: null,
      },
      {
        resolveImplicitProviders: async () => ({}),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    const parsed = JSON.parse(plan.contents) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    expect(parsed.providers?.custom?.apiKey).toBe("MY_CUSTOM_API_KEY");
    expect(plan.contents).not.toContain("sk-runtime-custom");
  });

  it("keeps existing models.json-only plaintext api keys to avoid upgrade auth loss", async () => {
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "merge",
            providers: {
              custom: {
                baseUrl: "https://custom.example/v1",
                api: "openai-completions",
                models: [createTestModel()],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        existingRaw: "",
        existingParsed: {
          providers: {
            custom: {
              baseUrl: "https://old.example/v1",
              api: "openai-completions",
              apiKey: "sk-existing-plaintext",
              models: [createTestModel("old-model", "Old")],
            },
          },
        },
      },
      {
        resolveImplicitProviders: async () => ({}),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    const parsed = JSON.parse(plan.contents) as {
      providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
    };
    expect(parsed.providers?.custom?.baseUrl).toBe("https://old.example/v1");
    expect(parsed.providers?.custom?.apiKey).toBe("sk-existing-plaintext");
  });

  it("replaces existing plaintext api keys when source config owns the provider secret", async () => {
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "merge",
            providers: {
              custom: {
                baseUrl: "https://custom.example/v1",
                api: "openai-completions",
                apiKey: "sk-config-plaintext",
                models: [createTestModel()],
              },
            },
          },
        },
        sourceConfigForSecrets: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://custom.example/v1",
                api: "openai-completions",
                apiKey: "sk-config-plaintext",
                models: [createTestModel()],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        existingRaw: "",
        existingParsed: {
          providers: {
            custom: {
              baseUrl: "https://old.example/v1",
              api: "openai-completions",
              apiKey: "sk-existing-plaintext",
              models: [createTestModel("old-model", "Old")],
            },
          },
        },
      },
      {
        resolveImplicitProviders: async () => ({}),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    const parsed = JSON.parse(plan.contents) as {
      providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
    };
    expect(parsed.providers?.custom?.apiKey).toBe(OPENCLAW_MANAGED_AUTH_MARKER);
    expect(plan.contents).not.toContain("sk-config-plaintext");
    expect(plan.contents).not.toContain("sk-existing-plaintext");
  });

  it("uses config env.vars entries for implicit provider discovery without mutating process.env", async () => {
    await withTempEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR], async () => {
      unsetEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR]);
      const { discoveryEnv, providers } = await resolveProvidersAndCaptureDiscoveryEnv(
        createConfigEnvVarsConfig(),
      );

      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
      expect(process.env[TEST_ENV_VAR]).toBeUndefined();
      expect(discoveryEnv?.OPENROUTER_API_KEY).toBe("from-config");
      expect(discoveryEnv?.[TEST_ENV_VAR]).toBe("from-config");
      expect(providers.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
    });
  });

  it("does not overwrite already-set host env vars while ensuring models.json", async () => {
    await withTempEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR], async () => {
      process.env.OPENROUTER_API_KEY = "from-host"; // pragma: allowlist secret
      process.env[TEST_ENV_VAR] = "from-host";
      const { discoveryEnv, providers } = await resolveProvidersAndCaptureDiscoveryEnv(
        createConfigEnvVarsConfig(),
      );

      expect(discoveryEnv?.OPENROUTER_API_KEY).toBe("from-host");
      expect(discoveryEnv?.[TEST_ENV_VAR]).toBe("from-host");
      expect(providers.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
      expect(process.env.OPENROUTER_API_KEY).toBe("from-host");
      expect(process.env[TEST_ENV_VAR]).toBe("from-host");
    });
  });
});
