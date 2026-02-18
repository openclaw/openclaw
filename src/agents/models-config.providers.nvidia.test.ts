import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { buildNvidiaProvider, resolveImplicitProviders } from "./models-config.providers.js";

describe("NVIDIA provider", () => {
  it("should include nvidia when NVIDIA_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["NVIDIA_API_KEY"]);
    process.env.NVIDIA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.nvidia).toBeDefined();
      expect(providers?.nvidia?.models?.length).toBeGreaterThan(0);
    } finally {
      envSnapshot.restore();
    }
  });

  it("resolves the nvidia api key value from env", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["NVIDIA_API_KEY"]);
    process.env.NVIDIA_API_KEY = "nvidia-test-api-key";

    try {
      const auth = await resolveApiKeyForProvider({
        provider: "nvidia",
        agentDir,
      });

      expect(auth.apiKey).toBe("nvidia-test-api-key");
      expect(auth.mode).toBe("api-key");
      expect(auth.source).toContain("NVIDIA_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("should build nvidia provider with correct configuration", () => {
    const provider = buildNvidiaProvider();
    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
  });

  it("should include default nvidia models", () => {
    const provider = buildNvidiaProvider();
    const modelIds = provider.models.map((m) => m.id);
    // Legacy defaults
    expect(modelIds).toContain("nvidia/llama-3.1-nemotron-70b-instruct");
    // Flagship chat
    expect(modelIds).toContain("meta/llama-3.3-70b-instruct");
    expect(modelIds).toContain("deepseek-ai/deepseek-v3.2");
    expect(modelIds).toContain("mistralai/mistral-large-3-675b-instruct-2512");
    expect(modelIds).toContain("moonshotai/kimi-k2.5");
    expect(modelIds).toContain("openai/gpt-oss-120b");
    // Reasoning
    expect(modelIds).toContain("deepseek-ai/deepseek-r1-distill-qwen-32b");
    expect(modelIds).toContain("qwen/qwq-32b");
    // Vision
    expect(modelIds).toContain("meta/llama-3.2-90b-vision-instruct");
    expect(modelIds).toContain("google/gemma-3n-e4b-it");
  });

  it("should have at least 50 models in the catalog", () => {
    const provider = buildNvidiaProvider();
    expect(provider.models.length).toBeGreaterThanOrEqual(50);
  });

  it("should mark vision models with image input", () => {
    const provider = buildNvidiaProvider();
    const visionModels = provider.models.filter((m) => m.input.includes("image"));
    expect(visionModels.length).toBeGreaterThanOrEqual(8);
    for (const model of visionModels) {
      expect(model.input).toContain("text");
      expect(model.input).toContain("image");
    }
  });

  it("should mark reasoning models correctly", () => {
    const provider = buildNvidiaProvider();
    const reasoningModels = provider.models.filter((m) => m.reasoning);
    expect(reasoningModels.length).toBeGreaterThanOrEqual(10);
  });
});

describe("MiniMax implicit provider (#15275)", () => {
  it("should use anthropic-messages API for API-key provider", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["MINIMAX_API_KEY"]);
    process.env.MINIMAX_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.minimax).toBeDefined();
      expect(providers?.minimax?.api).toBe("anthropic-messages");
      expect(providers?.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
    } finally {
      envSnapshot.restore();
    }
  });
});

describe("vLLM provider", () => {
  it("should not include vllm when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["VLLM_API_KEY"]);
    delete process.env.VLLM_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.vllm).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("should include vllm when VLLM_API_KEY is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["VLLM_API_KEY"]);
    process.env.VLLM_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.vllm).toBeDefined();
      expect(providers?.vllm?.apiKey).toBe("VLLM_API_KEY");
      expect(providers?.vllm?.baseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(providers?.vllm?.api).toBe("openai-completions");

      // Note: discovery is disabled in test environments (VITEST check)
      expect(providers?.vllm?.models).toEqual([]);
    } finally {
      envSnapshot.restore();
    }
  });
});
