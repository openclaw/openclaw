import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("moonshot implicit provider (#33637)", () => {
  it("uses explicit CN baseUrl when provided", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["MOONSHOT_API_KEY"]);
    process.env.MOONSHOT_API_KEY = "sk-test-cn";

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        explicitProviders: {
          moonshot: {
            baseUrl: "https://api.moonshot.cn/v1",
            api: "openai-completions",
            models: [
              {
                id: "kimi-k2.5",
                name: "Kimi K2.5",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
            ],
          },
        },
      });
      expect(providers?.moonshot).toBeDefined();
      expect(providers?.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
      expect(providers?.moonshot?.apiKey).toBeDefined();
      expect(providers?.moonshot?.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("keeps streaming usage opt-in unset before the final compat pass", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["MOONSHOT_API_KEY"]);
    process.env.MOONSHOT_API_KEY = "sk-test-custom";

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        explicitProviders: {
          moonshot: {
            baseUrl: "https://proxy.example.com/v1",
            api: "openai-completions",
            models: [],
          },
        },
      });
      expect(providers?.moonshot).toBeDefined();
      expect(providers?.moonshot?.baseUrl).toBe("https://proxy.example.com/v1");
      expect(providers?.moonshot?.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("includes moonshot when MOONSHOT_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["MOONSHOT_API_KEY"]);
    process.env.MOONSHOT_API_KEY = "sk-test";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.moonshot).toBeDefined();
      expect(providers?.moonshot?.apiKey).toBeDefined();
      expect(providers?.moonshot?.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
