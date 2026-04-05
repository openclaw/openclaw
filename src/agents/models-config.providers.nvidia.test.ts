import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import {
  installModelsConfigTestHooks,
  resolveImplicitProvidersForTest,
} from "./models-config.e2e-harness.js";
import {
  resolveEnvApiKeyVarName,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secrets.js";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";
const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";

installModelsConfigTestHooks();

describe("NVIDIA provider", () => {
  it("should include nvidia when NVIDIA_API_KEY is configured", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "nvidia",
      provider: {
        baseUrl: NVIDIA_BASE_URL,
        api: "openai-completions",
        models: [{ id: "nvidia/test-model" }],
      },
      env: { NVIDIA_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });
    expect(provider.apiKey).toBe("NVIDIA_API_KEY");
    expect(provider.models?.length).toBeGreaterThan(0);
  });

  it("resolves the nvidia api key value from env", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ NVIDIA_API_KEY: "nvidia-test-api-key" }, async () => {
      const auth = await resolveApiKeyForProvider({
        provider: "nvidia",
        agentDir,
      });

      expect(auth.apiKey).toBe("nvidia-test-api-key");
      expect(auth.mode).toBe("api-key");
      expect(auth.source).toContain("NVIDIA_API_KEY");
    });
  });
});

describe("MiniMax implicit provider (#15275)", () => {
  it("should use anthropic-messages API for API-key provider", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "minimax",
      provider: {
        baseUrl: MINIMAX_BASE_URL,
        api: "anthropic-messages",
        authHeader: true,
        models: [{ id: "MiniMax-M2.7" }],
      },
      env: { MINIMAX_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.api).toBe("anthropic-messages");
    expect(provider.authHeader).toBe(true);
    expect(provider.apiKey).toBe("MINIMAX_API_KEY");
    expect(provider.baseUrl).toBe("https://api.minimax.io/anthropic");
  });

  it("should respect MINIMAX_API_HOST env var for CN endpoint (#34487)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: {
        MINIMAX_API_KEY: "test-key",
        MINIMAX_API_HOST: "https://api.minimaxi.com",
      },
    });

    expect(providers?.minimax?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(providers?.["minimax-portal"]?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
  });

  it("should set authHeader for minimax portal provider", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: { MINIMAX_OAUTH_TOKEN: "portal-token" },
    });
    expect(providers?.["minimax-portal"]?.authHeader).toBe(true);
  });

  it("should include minimax portal provider when MINIMAX_OAUTH_TOKEN is configured", async () => {
    expect(
      resolveEnvApiKeyVarName("minimax-portal", {
        MINIMAX_OAUTH_TOKEN: "portal-token",
      } as NodeJS.ProcessEnv),
    ).toBe("MINIMAX_OAUTH_TOKEN");
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: { MINIMAX_OAUTH_TOKEN: "portal-token" },
    });
    expect(providers?.["minimax-portal"]?.authHeader).toBe(true);
  });
});

describe("vLLM provider", () => {
  it("should not include vllm when no API key is configured", () => {
    expect(resolveEnvApiKeyVarName("vllm", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("should include vllm when VLLM_API_KEY is set", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "vllm",
      provider: {
        baseUrl: VLLM_DEFAULT_BASE_URL,
        api: "openai-completions",
        models: [],
      },
      env: { VLLM_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.apiKey).toBe("VLLM_API_KEY");
    expect(provider.baseUrl).toBe(VLLM_DEFAULT_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toEqual([]);
  });
});
