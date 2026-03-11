import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("PPIO provider", () => {
  it("should include ppio when PPIO_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ PPIO_API_KEY: "test-key" }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.ppio).toBeDefined();
      expect(providers?.ppio?.baseUrl).toBe("https://api.ppinfra.com/v3/openai");
      expect(providers?.ppio?.api).toBe("openai-completions");
      expect(providers?.ppio?.models?.length).toBeGreaterThan(0);
    });
  });

  it("should not include ppio when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ PPIO_API_KEY: undefined }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.ppio).toBeUndefined();
    });
  });

  it("resolves the ppio api key value from env", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ PPIO_API_KEY: "ppio-test-api-key" }, async () => {
      const auth = await resolveApiKeyForProvider({
        provider: "ppio",
        agentDir,
      });

      expect(auth.apiKey).toBe("ppio-test-api-key");
      expect(auth.mode).toBe("api-key");
      expect(auth.source).toContain("PPIO_API_KEY");
    });
  });

  it("should use static catalog models in test env (discovery disabled)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ PPIO_API_KEY: "test-key" }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      const models = providers?.ppio?.models ?? [];
      const ids = models.map((m) => m.id);
      expect(ids).toContain("deepseek/deepseek-v3.2");
    });
  });
});
