import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { prepareAgentRuntimeAuthPlan } from "./prepare-auth.test-support.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

function openAIConfig(config: Record<string, unknown>): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: { baseUrl: "", models: [], ...config },
      },
    },
  } as OpenClawConfig;
}

function openAIOAuthStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 60_000,
      },
    },
  };
}

function lunaReasoningCatalog(): ModelDefinitionConfig[] {
  return [
    {
      id: "gpt-6-luna",
      name: "GPT-6-Luna",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "max"],
      },
    },
  ];
}

describe("native runtime auth deferral", () => {
  it("does not treat a models-only provider catalog as an authored host route", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-6-luna",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      harnessAuthBootstrap: "harness",
      config: openAIConfig({
        models: lunaReasoningCatalog(),
      }),
      authProfileStore: openAIOAuthStore(),
    });

    expect(plan.modelRoute).toBeUndefined();
    expect(plan.deferredRouteSupport).toEqual({
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    });
    expect(plan.credentialSource).toBeUndefined();
  });

  it("keeps a previously selected automatic profile on the host route for this run", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-6-luna",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      harnessAuthBootstrap: "harness",
      config: openAIConfig({ models: lunaReasoningCatalog() }),
      authProfileStore: openAIOAuthStore(),
      sessionAuthProfileId: "openai:chatgpt",
      sessionAuthProfileSource: "auto",
    });

    expect(plan.forwardedAuthProfileId).toBe("openai:chatgpt");
    expect(plan.modelRoute).toBeDefined();
  });

  it("honors explicit auth order for a reasoning-only catalog row", () => {
    const config: OpenClawConfig = {
      auth: { order: { openai: ["openai:chatgpt"] } },
      models: {
        providers: {
          openai: { baseUrl: "", models: lunaReasoningCatalog() },
        },
      },
    };
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-6-luna",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      harnessAuthBootstrap: "harness",
      config,
      authProfileStore: openAIOAuthStore(),
    });

    expect(plan.forwardedAuthProfileId).toBe("openai:chatgpt");
    expect(plan.modelRoute).toBeDefined();
  });

  it("keeps a user-pinned profile ahead of native auth on a reasoning-only row", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-6-luna",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      harnessAuthBootstrap: "harness",
      config: openAIConfig({ models: lunaReasoningCatalog() }),
      authProfileStore: openAIOAuthStore(),
      sessionAuthProfileId: "openai:chatgpt",
      sessionAuthProfileSource: "user",
    });

    expect(plan.forwardedAuthProfileId).toBe("openai:chatgpt");
    expect(plan.forwardedAuthProfileSource).toBe("user");
    expect(plan.modelRoute).toBeDefined();
  });

  it("keeps payload-shaping compat on the host route", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-6-luna",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        env: {},
        harnessId: "codex",
        harnessRuntime: "codex",
        harnessAuthBootstrap: "harness",
        config: openAIConfig({
          models: [
            {
              id: "gpt-6-luna",
              name: "GPT-6-Luna",
              compat: { supportsStore: false },
            },
          ],
        }),
        authProfileStore: { version: 1, profiles: {} },
      }),
    ).toThrow(/No route-compatible authentication source/u);
  });

  it("keeps an explicitly authored provider endpoint on the host route", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-6-luna",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        env: {},
        harnessId: "codex",
        harnessRuntime: "codex",
        harnessAuthBootstrap: "harness",
        config: openAIConfig({ baseUrl: "https://openai.example.test/v1" }),
        authProfileStore: { version: 1, profiles: {} },
      }),
    ).toThrow(/No route-compatible authentication source/u);
  });
});
