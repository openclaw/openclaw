import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MOONSHOT_BASE_URL as MOONSHOT_AI_BASE_URL,
  MOONSHOT_CN_BASE_URL,
} from "../plugins/provider-model-definitions.js";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";
import { applyNativeStreamingUsageCompat } from "./models-config.providers.js";
import { buildMoonshotProvider } from "./models-config.providers.static.js";

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
            baseUrl: MOONSHOT_CN_BASE_URL,
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
      expect(providers?.moonshot?.baseUrl).toBe(MOONSHOT_CN_BASE_URL);
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

  it("defaults to .ai baseUrl when no explicit provider", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["MOONSHOT_API_KEY"]);
    process.env.MOONSHOT_API_KEY = "sk-test";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.moonshot).toBeDefined();
      expect(providers?.moonshot?.baseUrl).toBe(MOONSHOT_AI_BASE_URL);
      expect(providers?.moonshot?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "kimi-k2.5", input: ["text", "image"] }),
          expect.objectContaining({ id: "kimi-k2-thinking", reasoning: true }),
          expect.objectContaining({ id: "kimi-k2-thinking-turbo", reasoning: true }),
          expect.objectContaining({ id: "kimi-k2-turbo", reasoning: false }),
        ]),
      );
      expect(providers?.moonshot?.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("opts native Moonshot baseUrls into streaming usage only after the final compat pass", () => {
    const defaultProviders = applyNativeStreamingUsageCompat({
      moonshot: buildMoonshotProvider(),
    });
    expect(defaultProviders.moonshot?.models?.[0]?.compat?.supportsUsageInStreaming).toBe(true);

    const cnProviders = applyNativeStreamingUsageCompat({
      moonshot: {
        ...buildMoonshotProvider(),
        baseUrl: MOONSHOT_CN_BASE_URL,
      },
    });
    expect(cnProviders.moonshot?.models?.[0]?.compat?.supportsUsageInStreaming).toBe(true);

    const customProviders = applyNativeStreamingUsageCompat({
      moonshot: {
        ...buildMoonshotProvider(),
        baseUrl: "https://proxy.example.com/v1",
      },
    });
    expect(customProviders.moonshot?.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
  });
});
