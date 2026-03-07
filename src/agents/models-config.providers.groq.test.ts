import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Groq provider", () => {
  it("should include groq when GROQ_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ GROQ_API_KEY: "test-key" }, async () => {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.groq).toBeDefined();
      expect(providers?.groq?.apiKey).toBe("GROQ_API_KEY");
      expect(providers?.groq?.baseUrl).toBe("https://api.groq.com/openai/v1");
      expect(providers?.groq?.models?.[0]?.id).toBe("llama-3.3-70b-versatile");
    });
  });
});
