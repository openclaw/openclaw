// Verifies implicit provider secret wiring for NVIDIA, MiniMax portal, and vLLM.
import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import {
  resolveEnvApiKeyVarName,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secret-helpers.js";

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: () => undefined,
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: () => [],
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("./model-auth-env-vars.js", () => {
  // Fixed candidate map keeps provider-secret resolution deterministic.
  const candidates = {
    "minimax-portal": ["MINIMAX_OAUTH_TOKEN"],
    nvidia: ["NVIDIA_API_KEY"],
    vllm: ["VLLM_API_KEY"],
  } as const;
  return {
    listKnownProviderEnvApiKeyNames: () => [...new Set(Object.values(candidates).flat())],
    resolveProviderEnvAuthLookupMaps: () => ({
      aliasMap: {},
      envCandidateMap: candidates,
      authEvidenceMap: {},
    }),
  };
});

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

function createTestModel(id: string): ModelDefinitionConfig {
  // Minimal catalog row; these tests care about auth wiring, not model metadata.
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  };
}

describe("NVIDIA provider", () => {
  it("should include nvidia when NVIDIA_API_KEY is configured", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "nvidia",
      provider: {
        baseUrl: NVIDIA_BASE_URL,
        api: "openai-completions",
        models: [createTestModel("nvidia/test-model")],
      },
      env: { NVIDIA_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });
    expect(provider.apiKey).toBe("NVIDIA_API_KEY");
    expect(provider.models).toStrictEqual([createTestModel("nvidia/test-model")]);
  });

  it("resolves the nvidia api key value from env", () => {
    const auth = resolveEnvApiKey("nvidia", {
      NVIDIA_API_KEY: "nvidia-test-api-key",
    } as NodeJS.ProcessEnv);

    expect(auth).toEqual({
      apiKey: "nvidia-test-api-key",
      source: "env: NVIDIA_API_KEY",
    });
  });
});

describe("MiniMax implicit provider (#15275)", () => {
  it("should include minimax portal provider when MINIMAX_OAUTH_TOKEN is configured", () => {
    expect(
      resolveEnvApiKeyVarName("minimax-portal", {
        MINIMAX_OAUTH_TOKEN: "portal-token",
      } as NodeJS.ProcessEnv),
    ).toBe("MINIMAX_OAUTH_TOKEN");
  });
});

describe("vLLM provider", () => {
  it("should not include vllm when no API key is configured", () => {
    expect(resolveEnvApiKeyVarName("vllm", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
