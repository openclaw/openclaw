import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { buildGroqProvider, resolveImplicitProviders } from "./models-config.providers.js";

describe("Groq provider", () => {
  it("should include groq when GROQ_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GROQ_API_KEY"]);
    process.env.GROQ_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.groq).toBeDefined();
      expect(providers?.groq?.models?.length).toBeGreaterThan(0);
    } finally {
      envSnapshot.restore();
    }
  });

  it("resolves the groq api key value from env", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GROQ_API_KEY"]);
    process.env.GROQ_API_KEY = "groq-test-api-key";

    try {
      const auth = await resolveApiKeyForProvider({
        provider: "groq",
        agentDir,
      });

      expect(auth.apiKey).toBe("groq-test-api-key");
      expect(auth.mode).toBe("api-key");
      expect(auth.source).toContain("GROQ_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("should build groq provider with correct configuration", () => {
    const provider = buildGroqProvider();
    expect(provider.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
  });

  it("should include default groq models", () => {
    const provider = buildGroqProvider();
    const modelIds = provider.models.map((m) => m.id);
    expect(modelIds).toContain("llama-3.3-70b-versatile");
    expect(modelIds).toContain("mixtral-8x7b-32768");
    expect(modelIds).toContain("deepseek-r1-distill-llama-70b");
  });
});
