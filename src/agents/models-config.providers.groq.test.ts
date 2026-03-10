import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";
import { buildGroqProvider } from "./models-config.providers.js";

describe("Groq provider", () => {
  it("should include groq when GROQ_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync(
      { GROQ_API_KEY: "test-key" }, // pragma: allowlist secret
      async () => {
        const providers = await resolveImplicitProvidersForTest({ agentDir });
        expect(providers?.groq).toBeDefined();
        expect(providers?.groq?.apiKey).toBe("GROQ_API_KEY");
        expect(providers?.groq?.api).toBe("openai-completions");
      },
    );
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
    const modelIds = provider.models.map((model) => model.id);
    expect(modelIds).toContain("llama-3.3-70b-versatile");
    expect(modelIds).toContain("deepseek-r1-distill-llama-70b");
    expect(modelIds).toContain("qwen-qwq-32b");
  });
});
