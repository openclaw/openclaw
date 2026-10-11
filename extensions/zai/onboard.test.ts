import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { expectProviderOnboardPreservesPrimary } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "./model-definitions.js";
import { applyZaiConfig, applyZaiProviderConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("zai onboard", () => {
  let defaultCfg: ReturnType<typeof applyZaiConfig>;

  beforeAll(() => {
    defaultCfg = applyZaiConfig({});
  });

  it("resolves GLM-5.3 models through the selected Coding Plan or custom endpoint", async () => {
    for (const [name, cfg, expectedBaseUrl] of [
      ["coding-cn", applyZaiConfig({}, { endpoint: "coding-cn" }), ZAI_CODING_CN_BASE_URL],
      [
        "custom",
        applyZaiConfig({
          models: {
            providers: {
              zai: {
                baseUrl: "https://proxy.example.test/zai",
                api: "openai-completions",
                models: [],
              },
            },
          },
        }),
        "https://proxy.example.test/zai",
      ],
    ] as const) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-zai-${name}-`));
      try {
        const modelsPath = path.join(dir, "models.json");
        await fs.writeFile(
          modelsPath,
          JSON.stringify({
            ...cfg.models,
            providers: {
              ...cfg.models?.providers,
              zai: { ...cfg.models?.providers?.zai, apiKey: "test-key" },
            },
          }),
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

  it("defaults general endpoints to GLM-5.2 and Coding Plan endpoints to GLM-5.3", () => {
    const codingCfg = applyZaiConfig({}, { endpoint: "coding-global" });
    const existingCodingCfg = applyZaiConfig({
      models: {
        providers: {
          zai: {
            baseUrl: `${ZAI_CODING_GLOBAL_BASE_URL}/`,
            api: "openai-completions",
            models: [],
          },
        },
      },
    });

    expect(resolveAgentModelPrimaryValue(defaultCfg.agents?.defaults?.model)).toBe("zai/glm-5.2");
    expect(codingCfg.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_GLOBAL_BASE_URL);
    expect(resolveAgentModelPrimaryValue(codingCfg.agents?.defaults?.model)).toBe("zai/glm-5.3");
    expect(resolveAgentModelPrimaryValue(existingCodingCfg.agents?.defaults?.model)).toBe(
      "zai/glm-5.3",
    );
  });

  it("does not overwrite existing primary model in provider-only mode", () => {
    expectProviderOnboardPreservesPrimary({
      applyProviderConfig: applyZaiProviderConfig,
      primaryModelRef: "anthropic/claude-opus-4-5",
    });
  });

  it("declares every endpoint the onboarding can select so the catalog stays eligible", () => {
    const declaredHosts = new Set(manifest.providerEndpoints.flatMap((entry) => entry.hosts));
    for (const baseUrl of [
      ZAI_GLOBAL_BASE_URL,
      ZAI_CODING_GLOBAL_BASE_URL,
      ZAI_CN_BASE_URL,
      ZAI_CODING_CN_BASE_URL,
    ]) {
      expect(
        declaredHosts.has(new URL(baseUrl).hostname),
        `${baseUrl} must stay declared in providerEndpoints, otherwise the manifest catalog is excluded for that endpoint`,
      ).toBe(true);
    }
  });
});
