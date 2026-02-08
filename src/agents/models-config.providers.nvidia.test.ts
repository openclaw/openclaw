import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveApiKeyForProvider } from "./model-auth.js";
import {
  buildNvidiaProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

describe("NVIDIA provider", () => {
  it("should include nvidia when NVIDIA_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.nvidia).toBeDefined();
      expect(providers?.nvidia?.models?.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) {
        delete process.env.NVIDIA_API_KEY;
      } else {
        process.env.NVIDIA_API_KEY = previous;
      }
    }
  });

  it("resolves the nvidia api key value from env", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.NVIDIA_API_KEY;
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
      if (previous === undefined) {
        delete process.env.NVIDIA_API_KEY;
      } else {
        process.env.NVIDIA_API_KEY = previous;
      }
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
    expect(modelIds).toContain("nvidia/llama-3.1-nemotron-70b-instruct");
    expect(modelIds).toContain("nvidia/llama-3.3-70b-instruct");
    expect(modelIds).toContain("nvidia/mistral-nemo-minitron-8b-8k-instruct");
  });
});
