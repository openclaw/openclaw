import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { expectProviderOnboardPreservesPrimary } from "openclaw/plugin-sdk/provider-test-contracts";
import { expect, it } from "vitest";
import {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "./model-definitions.js";
import { applyZaiConfig, applyZaiProviderConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function withBaseUrl(baseUrl: string) {
  return {
    models: { providers: { zai: { baseUrl, api: "openai-completions" as const, models: [] } } },
  };
}
function primary(cfg: ReturnType<typeof applyZaiConfig>) {
  return resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
}
const customUrl = "https://proxy.example.test/zai";

it("zai onboard resolves GLM-5.3 models through the selected Coding Plan or custom endpoint", async () => {
  for (const [name, cfg, expectedBaseUrl] of [
    ["coding-cn", applyZaiConfig({}, { endpoint: "coding-cn" }), ZAI_CODING_CN_BASE_URL],
    ["custom", applyZaiConfig(withBaseUrl(customUrl)), customUrl],
  ] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-zai-${name}-`));
    try {
      const modelsPath = path.join(dir, "models.json");
      const zai = { ...cfg.models?.providers?.zai, apiKey: "test-key" };
      await fs.writeFile(
        modelsPath,
        JSON.stringify({ ...cfg.models, providers: { ...cfg.models?.providers, zai } }),
      );
      const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
      expect(registry.getError()).toBeUndefined();
      for (const modelId of ["glm-5.3", "glm-5.3-flash"]) {
        expect(registry.find("zai", modelId)?.baseUrl).toBe(expectedBaseUrl);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

it("zai onboard defaults general endpoints to GLM-5.2 and Coding Plan endpoints to GLM-5.3", () => {
  const codingCfg = applyZaiConfig({}, { endpoint: "coding-global" });
  const existingCodingCfg = applyZaiConfig(withBaseUrl(`${ZAI_CODING_GLOBAL_BASE_URL}/`));
  expect(primary(applyZaiConfig({}))).toBe("zai/glm-5.2");
  expect(codingCfg.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_GLOBAL_BASE_URL);
  expect(primary(codingCfg)).toBe("zai/glm-5.3");
  expect(primary(existingCodingCfg)).toBe("zai/glm-5.3");
});

it("zai onboard does not overwrite existing primary model in provider-only mode", () => {
  expectProviderOnboardPreservesPrimary({
    applyProviderConfig: applyZaiProviderConfig,
    primaryModelRef: "anthropic/claude-opus-4-5",
  });
});

it("zai onboard declares every selectable endpoint so the catalog stays eligible", () => {
  const declaredHosts = new Set(manifest.providerEndpoints.flatMap((entry) => entry.hosts));
  for (const baseUrl of [
    ZAI_GLOBAL_BASE_URL,
    ZAI_CODING_GLOBAL_BASE_URL,
    ZAI_CN_BASE_URL,
    ZAI_CODING_CN_BASE_URL,
  ]) {
    expect(
      declaredHosts.has(new URL(baseUrl).hostname),
      `${baseUrl} must be declared in providerEndpoints for catalog eligibility`,
    ).toBe(true);
  }
});
