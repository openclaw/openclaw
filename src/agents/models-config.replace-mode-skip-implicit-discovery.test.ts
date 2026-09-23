import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import * as providers from "./models-config.providers.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

afterEach(() => vi.restoreAllMocks());

function createExplicitProvider(): ProviderConfig {
  return {
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    apiKey: "EXPLICIT_API_KEY",
    models: [
      {
        id: "test/explicit-model",
        name: "Explicit Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ],
  };
}

function createImplicitProvider(): ProviderConfig {
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

describe("models-config plan: replace mode skips implicit discovery", () => {
  it.each([
    { mode: "replace", calls: 0, providerIds: ["explicit"] },
    { mode: "merge", calls: 1, providerIds: ["explicit", "openrouter"] },
    { mode: undefined, calls: 1, providerIds: ["explicit", "openrouter"] },
  ] as const)("plans providers with models.mode=$mode", async ({ mode, calls, providerIds }) => {
    const explicitProvider = createExplicitProvider();
    const cfg: OpenClawConfig = {
      models: {
        ...(mode ? { mode } : {}),
        providers: { explicit: explicitProvider },
      },
    };

    const resolveImplicitSpy = vi
      .spyOn(providers, "resolveImplicitProviders")
      .mockResolvedValue({ openrouter: createImplicitProvider() });

    const plan = await planModelsJsonForTest({
      cfg,
      agentDir: "/tmp/openclaw-models-config-replace-test",
      env: {},
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    });

    expect(resolveImplicitSpy).toHaveBeenCalledTimes(calls);
    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error(`Expected write plan, got ${plan.action}`);
    }
    const generated = JSON.parse(plan.contents) as { providers: Record<string, ProviderConfig> };
    expect(Object.keys(generated.providers).toSorted()).toEqual(providerIds);
    expect(generated.providers.explicit).toEqual(explicitProvider);
  });

  it("forwards resolved runtime config separately from source config", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          explicit: {
            ...createExplicitProvider(),
            apiKey: { source: "exec", provider: "must-not-run", id: "explicit" },
          },
        },
      },
    };
    const discoveryAuthConfig: OpenClawConfig = {
      models: {
        providers: {
          explicit: {
            ...createExplicitProvider(),
            apiKey: "resolved-runtime-key",
          },
        },
      },
    };
    const resolveImplicitSpy = vi
      .spyOn(providers, "resolveImplicitProviders")
      .mockResolvedValue({});

    const plan = await planModelsJsonForTest({
      cfg,
      discoveryAuthConfig,
      agentDir: "/tmp/openclaw-models-config-auth-test",
      env: {},
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    });

    expect(resolveImplicitSpy).toHaveBeenCalledOnce();
    expect(resolveImplicitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              explicit: expect.objectContaining({
                apiKey: { source: "exec", provider: "must-not-run", id: "explicit" },
              }),
            }),
          }),
        }),
        discoveryAuthConfig,
        sourceConfigForSecrets: cfg,
      }),
    );
    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error(`Expected write plan, got ${plan.action}`);
    }
    const generated = JSON.parse(plan.contents) as { providers: Record<string, ProviderConfig> };
    expect(Object.keys(generated.providers)).toEqual(["explicit"]);
  });
});
