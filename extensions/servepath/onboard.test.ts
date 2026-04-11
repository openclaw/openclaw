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
  applyServepathConfig,
  applyServepathProviderConfig,
  SERVEPATH_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("servepath onboard", () => {
  it("adds the default alias and preserves an existing alias", () => {
    const withDefault = applyServepathProviderConfig({});
    expect(Object.keys(withDefault.agents?.defaults?.models ?? {})).toContain(
      SERVEPATH_DEFAULT_MODEL_REF,
    );
    expect(withDefault.agents?.defaults?.models?.[SERVEPATH_DEFAULT_MODEL_REF]?.alias).toBe(
      "servepath",
    );

    const withAlias = applyServepathProviderConfig({
      agents: {
        defaults: {
          models: {
            [SERVEPATH_DEFAULT_MODEL_REF]: { alias: "Servepath Router" },
          },
        },
      },
    });
    expect(withAlias.agents?.defaults?.models?.[SERVEPATH_DEFAULT_MODEL_REF]?.alias).toBe(
      "Servepath Router",
    );
  });

  it("sets the primary model and preserves existing fallbacks", () => {
    const cfg = applyServepathConfig({});
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      SERVEPATH_DEFAULT_MODEL_REF,
    );

    const cfgWithFallbacks = applyServepathConfig(createConfigWithFallbacks());
    expect(resolveAgentModelFallbackValues(cfgWithFallbacks.agents?.defaults?.model)).toEqual([
      ...EXPECTED_FALLBACKS,
    ]);
  });
});
