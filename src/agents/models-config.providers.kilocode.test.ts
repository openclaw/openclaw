import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildKilocodeProvider, resolveImplicitProviders } from "./models-config.providers.js";

const KILOCODE_MODEL_IDS = [
  "anthropic/claude-opus-4.6",
  "z-ai/glm-5:free",
  "minimax/minimax-m2.5:free",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5.2",
  "google/gemini-3-pro-preview",
  "google/gemini-3-flash-preview",
  "x-ai/grok-code-fast-1",
  "moonshotai/kimi-k2.5",
];

describe("Kilo Gateway implicit provider", () => {
  it("should include kilocode when KILOCODE_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
    process.env.KILOCODE_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.kilocode).toBeDefined();
      expect(providers?.kilocode?.models?.length).toBeGreaterThan(0);
    } finally {
      envSnapshot.restore();
    }
  });

  it("should not include kilocode when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
    delete process.env.KILOCODE_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.kilocode).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("should build kilocode provider with correct configuration", () => {
    const provider = buildKilocodeProvider();
    expect(provider.baseUrl).toBe("https://api.kilo.ai/api/gateway/");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
  });

  it("should include the default kilocode model", () => {
    const provider = buildKilocodeProvider();
    const modelIds = provider.models.map((m) => m.id);
    expect(modelIds).toContain("anthropic/claude-opus-4.6");
  });

  it("should include the full surfaced model catalog", () => {
    const provider = buildKilocodeProvider();
    const modelIds = provider.models.map((m) => m.id);
    for (const modelId of KILOCODE_MODEL_IDS) {
      expect(modelIds).toContain(modelId);
    }
  });
});
