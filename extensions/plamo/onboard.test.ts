import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  createConfigWithFallbacks,
  EXPECTED_FALLBACKS,
} from "../../test/helpers/plugins/onboard-config.js";
import { applyPlamoConfig, applyPlamoProviderConfig, PLAMO_DEFAULT_MODEL_REF } from "./onboard.js";

describe("plamo onboard", () => {
  it("adds the Preferred Networks provider in provider-only mode without changing the primary model", () => {
    const cfg = applyPlamoProviderConfig({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
        },
      },
    });

    expect(cfg.models?.providers?.plamo).toMatchObject({
      baseUrl: "https://api.platform.preferredai.jp/v1",
      api: "openai-completions",
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.4");
  });

  it("sets the default PLaMo model without changing ACP backend config", () => {
    const cfg = applyPlamoConfig({});

    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      PLAMO_DEFAULT_MODEL_REF,
    );
    expect(cfg.acp?.backend).toBeUndefined();
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyPlamoConfig(createConfigWithFallbacks());
    expect(resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)).toEqual([
      ...EXPECTED_FALLBACKS,
    ]);
  });
});
