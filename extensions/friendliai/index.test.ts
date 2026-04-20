import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import friendliaiPlugin from "./index.js";
import {
  FRIENDLIAI_BASE_URL,
  FRIENDLIAI_DEFAULT_CONTEXT_WINDOW,
  FRIENDLIAI_DEFAULT_MAX_TOKENS,
  FRIENDLIAI_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

function createDynamicContext(params: {
  provider: string;
  modelId: string;
  models: ProviderRuntimeModel[];
}): ProviderResolveDynamicModelContext {
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          params.models.find(
            (model) =>
              model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
          ) ?? null
        );
      },
    } as ModelRegistry,
  };
}

describe("friendliai provider plugin", () => {
  it("registers FriendliAI with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(friendliaiPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "friendliai-api-key",
    });

    expect(provider.id).toBe("friendliai");
    expect(provider.label).toBe("FriendliAI");
    expect(provider.aliases).toEqual(["friendli"]);
    expect(provider.envVars).toEqual(["FRIENDLIAI_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved?.provider.id).toBe("friendliai");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the FriendliAI catalog with expected models", async () => {
    const provider = await registerSingleProviderPlugin(friendliaiPlugin);
    const catalog = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-token" }),
      resolveProviderAuth: () => ({
        apiKey: "test-token",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe(FRIENDLIAI_BASE_URL);
    expect(catalog.provider.models?.length).toBeGreaterThanOrEqual(1);
    // Default model is first in catalog
    expect(catalog.provider.models?.[0]?.id).toBe(FRIENDLIAI_DEFAULT_MODEL_ID);
    expect(catalog.provider.models?.[0]).toMatchObject({
      reasoning: true,
      input: ["text"],
      contextWindow: FRIENDLIAI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: FRIENDLIAI_DEFAULT_MAX_TOKENS,
    });
  });

  it("resolves forward-compat FriendliAI model ids from the default template", async () => {
    const provider = await registerSingleProviderPlugin(friendliaiPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "friendliai",
        modelId: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        models: [
          {
            id: FRIENDLIAI_DEFAULT_MODEL_ID,
            name: FRIENDLIAI_DEFAULT_MODEL_ID,
            provider: "friendliai",
            api: "openai-completions",
            baseUrl: FRIENDLIAI_BASE_URL,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: FRIENDLIAI_DEFAULT_CONTEXT_WINDOW,
            maxTokens: FRIENDLIAI_DEFAULT_MAX_TOKENS,
          },
        ],
      }),
    );

    expect(resolved).toMatchObject({
      provider: "friendliai",
      id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      api: "openai-completions",
      baseUrl: FRIENDLIAI_BASE_URL,
      reasoning: false,
    });
  });

  it("falls back to normalizeModelCompat when template model is not in registry", async () => {
    const provider = await registerSingleProviderPlugin(friendliaiPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "friendliai",
        modelId: "some-org/some-custom-model",
        models: [],
      }),
    );

    expect(resolved).toMatchObject({
      provider: "friendliai",
      id: "some-org/some-custom-model",
      api: "openai-completions",
      baseUrl: FRIENDLIAI_BASE_URL,
      reasoning: false,
    });
  });

  it("returns undefined for empty model id", async () => {
    const provider = await registerSingleProviderPlugin(friendliaiPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "friendliai",
        modelId: "   ",
        models: [],
      }),
    );

    expect(resolved).toBeUndefined();
  });
});
