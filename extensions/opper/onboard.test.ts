import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { getStaticOpperModelCatalog, OPPER_BASE_URL } from "./api.js";
import { applyOpperConfig, OPPER_DEFAULT_MODEL_REF } from "./onboard.js";

describe("Opper provider config", () => {
  it("sets up the Opper default for a new config", () => {
    const result = applyOpperConfig({});
    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
      "opper/claude-sonnet-5-5",
    );
    expect(result.agents?.defaults?.models?.[OPPER_DEFAULT_MODEL_REF]).toEqual({
      alias: "Opper",
    });
    expect(result.models?.providers?.opper).toMatchObject({
      baseUrl: "https://api.opper.ai/v3/compat/",
      api: "openai-completions",
    });
  });

  it("seeds the static catalog in replace mode", () => {
    const result = applyOpperConfig({ models: { mode: "replace" } });
    expect(result.models?.providers?.opper?.models.map((model) => model.id)).toEqual(
      getStaticOpperModelCatalog().map((model) => model.id),
    );
  });

  it.each([undefined, "merge"] as const)(
    "preserves authored rows without seeding %s config",
    (mode) => {
      expect(applyOpperConfig({ models: { mode } }).models?.providers?.opper?.models).toEqual([]);
      const authored = {
        ...getStaticOpperModelCatalog()[0]!,
        id: "operator-model",
        name: "My model",
      };
      const result = applyOpperConfig({
        models: {
          mode,
          providers: { opper: { baseUrl: OPPER_BASE_URL, models: [authored] } },
        },
      });
      expect(result.models?.providers?.opper?.models).toEqual([authored]);
    },
  );
});
