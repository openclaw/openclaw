import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { resolveImplicitProvidersForTest } from "../../src/agents/models-config.e2e-harness.js";
import type { ModelDefinitionConfig } from "../../src/config/types.models.js";

function buildExplicitKimiModels(): ModelDefinitionConfig[] {
  return [
    {
      id: "kimi-code",
      name: "Kimi Code",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
    },
  ];
}

describe("Kimi implicit provider (#22409)", () => {
  it("should include Kimi when KIMI_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KIMI_API_KEY"]);
    process.env.KIMI_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.kimi).toBeDefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("should not include Kimi when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KIMI_API_KEY"]);
    delete process.env.KIMI_API_KEY;

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.kimi).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses explicit legacy kimi-coding baseUrl when provided", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KIMI_API_KEY"]);
    process.env.KIMI_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        explicitProviders: {
          "kimi-coding": {
            baseUrl: "https://kimi.example.test/coding/",
            api: "anthropic-messages",
            models: buildExplicitKimiModels(),
          },
        },
      });
      expect(providers?.kimi?.baseUrl).toBe("https://kimi.example.test/coding/");
    } finally {
      envSnapshot.restore();
    }
  });

  it("merges explicit legacy kimi-coding headers on top of the built-in user agent", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KIMI_API_KEY"]);
    process.env.KIMI_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        explicitProviders: {
          "kimi-coding": {
            baseUrl: "https://api.kimi.com/coding/",
            api: "anthropic-messages",
            headers: {
              "User-Agent": "custom-kimi-client/1.0",
              "X-Kimi-Tenant": "tenant-a",
            },
            models: buildExplicitKimiModels(),
          },
        },
      });
      expect(providers?.kimi?.headers).toEqual({
        "User-Agent": "custom-kimi-client/1.0",
        "X-Kimi-Tenant": "tenant-a",
      });
    } finally {
      envSnapshot.restore();
    }
  });
});
