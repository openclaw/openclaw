import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.ts";
import { buildStaticCatalog } from "./deepinfra-models.ts";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.ts";

const DEEPINFRA_MODEL_IDS = [
  "openai/gpt-oss-120b",
  "MiniMaxAI/MiniMax-M2.5",
  "zai-org/GLM-5",
  "moonshotai/Kimi-K2.5",
];

describe("DeepInfra implicit provider", () => {
  it("should include deepinfra when DEEPINFRA_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["DEEPINFRA_API_KEY"]);
    process.env.DEEPINFRA_API_KEY = "test-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.deepinfra).toBeDefined();
      expect(providers?.deepinfra?.models?.length).toBeGreaterThan(0);
    } finally {
      envSnapshot.restore();
    }
  });

  it("should not include deepinfra when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["DEEPINFRA_API_KEY"]);
    delete process.env.DEEPINFRA_API_KEY;

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.deepinfra).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("should build deepinfra provider with correct configuration", () => {
    const models = buildStaticCatalog();
    expect(models).toBeDefined();
    expect(models.length).toBeGreaterThan(0);
  });

  it("should include the default deepinfra model", () => {
    const models = buildStaticCatalog();
    const modelIds = models.map((m) => m.id);
    expect(modelIds).toContain("openai/gpt-oss-120b");
  });

  it("should include the static fallback catalog", () => {
    const models = buildStaticCatalog();
    const modelIds = models.map((m) => m.id);
    for (const modelId of DEEPINFRA_MODEL_IDS) {
      expect(modelIds).toContain(modelId);
    }
    expect(models).toHaveLength(DEEPINFRA_MODEL_IDS.length);
  });
});
