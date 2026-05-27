import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  createConfigWithFallbacks,
  EXPECTED_FALLBACKS,
} from "../../test/helpers/plugins/onboard-config.js";
import {
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  OPENROUTER_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("openrouter onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    const withDefault = applyOpenrouterProviderConfig({});
    expect(Object.keys(withDefault.agents?.defaults?.models ?? {})).toContain(
      OPENROUTER_DEFAULT_MODEL_REF,
    );

    const withAlias = applyOpenrouterProviderConfig({
      agents: {
        defaults: {
          models: {
            [OPENROUTER_DEFAULT_MODEL_REF]: { alias: "Router" },
          },
        },
      },
    });
    expect(withAlias.agents?.defaults?.models?.[OPENROUTER_DEFAULT_MODEL_REF]?.alias).toBe(
      "Router",
    );
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    const cfg = applyOpenrouterConfig({});
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      OPENROUTER_DEFAULT_MODEL_REF,
    );

    const cfgWithFallbacks = applyOpenrouterConfig(createConfigWithFallbacks());
    expect(resolveAgentModelFallbackValues(cfgWithFallbacks.agents?.defaults?.model)).toEqual([
      ...EXPECTED_FALLBACKS,
    ]);
  });
});
