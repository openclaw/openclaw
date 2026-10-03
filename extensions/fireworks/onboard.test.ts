import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyFireworksConfig } from "./onboard.js";
import { FIREWORKS_DEFAULT_MODEL_REF, buildFireworksCatalogModels } from "./provider-catalog.js";

describe("Fireworks onboarding", () => {
  it("applies the manifest catalog, default, and alias in replace mode", () => {
    const config = applyFireworksConfig({ models: { mode: "replace" } });

    expect(config.models?.providers?.fireworks?.models).toEqual(buildFireworksCatalogModels());
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      "fireworks/accounts/fireworks/routers/glm-5p3-fast",
    );
    expect(config.agents?.defaults?.models).toEqual({
      [FIREWORKS_DEFAULT_MODEL_REF]: { alias: "GLM 5.3 Fast" },
    });
  });

  it("preserves an explicitly configured retired router and its alias", () => {
    const pinnedRef = "fireworks/accounts/fireworks/routers/glm-5p2-fast";
    const config = applyFireworksConfig({
      agents: {
        defaults: { model: pinnedRef, models: { [pinnedRef]: { alias: "Pinned route" } } },
      },
    });

    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(pinnedRef);
    expect(config.agents?.defaults?.models?.[pinnedRef]).toEqual({ alias: "Pinned route" });
  });

  it("leaves ordinary catalogs runtime-owned", () => {
    const config = applyFireworksConfig({});

    expect(config.models?.providers?.fireworks?.models).toEqual([]);
    expect(config.agents?.defaults?.models?.[FIREWORKS_DEFAULT_MODEL_REF]).toEqual({
      alias: "GLM 5.3 Fast",
    });
    expect(applyFireworksConfig(config)).toEqual(config);
  });
});
