import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  type OpenClawConfig,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPINFRA_BASE_URL } from "./media-models.js";
import { applyDeepInfraConfig } from "./onboard.js";
import { DEEPINFRA_DEFAULT_MODEL_REF, DEEPINFRA_MODEL_CATALOG } from "./provider-static-catalog.js";

const { resolveEnvApiKey } = providerAuth;

const emptyCfg: OpenClawConfig = {};

describe("DeepInfra provider config", () => {
  describe("applyDeepInfraConfig", () => {
    it("preserves authored costs and alias-only setup without pinning a catalog", () => {
      const cost = { input: 7, output: 0, cacheRead: 0.7, cacheWrite: 0 };
      const ref = "deepinfra/fixture/authored";
      const model = { ...DEEPINFRA_MODEL_CATALOG[0]!, id: "fixture/authored", cost };
      const config: OpenClawConfig = {
        models: { providers: { deepinfra: { baseUrl: DEEPINFRA_BASE_URL, models: [model] } } },
        agents: {
          defaults: { model: { primary: ref }, models: { [ref]: { alias: "Authored" } } },
        },
      };
      const result = applyDeepInfraConfig(config, ref);
      expect(result.models).toEqual(config.models);
      expect(result.agents?.defaults).toEqual(config.agents?.defaults);
      expect(applyDeepInfraConfig({}).models?.providers?.deepinfra).toBeUndefined();
    });

    it("sets the default model and DeepInfra alias", () => {
      const result = applyDeepInfraConfig(emptyCfg);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
        "deepinfra/deepseek-ai/DeepSeek-V4-Flash",
      );
      expect(result.agents?.defaults?.models?.[DEEPINFRA_DEFAULT_MODEL_REF]?.alias).toBe(
        "DeepInfra",
      );
    });

    it("honors a fallback ref when discovery picked a non-default model", () => {
      const fallbackRef = "deepinfra/other/awesome-model";
      const result = applyDeepInfraConfig(emptyCfg, fallbackRef);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(fallbackRef);
      expect(result.agents?.defaults?.models?.[fallbackRef]?.alias).toBe("DeepInfra");
    });
  });

  describe("env var resolution", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("resolves DEEPINFRA_API_KEY from env", () => {
      vi.stubEnv("DEEPINFRA_API_KEY", "test-deepinfra-key");
      const result = resolveEnvApiKey("deepinfra");
      expect(result?.apiKey).toBe("test-deepinfra-key");
      expect(result?.source.endsWith("DEEPINFRA_API_KEY")).toBe(true);
    });

    it("returns null when DEEPINFRA_API_KEY is not set", () => {
      vi.stubEnv("DEEPINFRA_API_KEY", undefined);
      expect(resolveEnvApiKey("deepinfra")).toBeNull();
    });
  });
});
