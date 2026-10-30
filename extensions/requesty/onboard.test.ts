import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { getStaticRequestyModelCatalog, REQUESTY_BASE_URL } from "./api.js";
import { applyRequestyConfig, REQUESTY_DEFAULT_MODEL_REF } from "./onboard.js";

describe("Requesty provider config", () => {
  it("sets up the Requesty default for a new config", () => {
    const result = applyRequestyConfig({});
    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
      "requesty/claude-sonnet-5-5",
    );
    expect(result.agents?.defaults?.models?.[REQUESTY_DEFAULT_MODEL_REF]).toEqual({
      alias: "Requesty",
    });
    expect(result.models?.providers?.requesty).toMatchObject({
      baseUrl: "https://router.requesty.ai/v1/",
      api: "openai-completions",
    });
  });

  it("seeds the static catalog in replace mode", () => {
    const result = applyRequestyConfig({ models: { mode: "replace" } });
    expect(result.models?.providers?.requesty?.models.map((model) => model.id)).toEqual(
      getStaticRequestyModelCatalog().map((model) => model.id),
    );
  });

  it.each([undefined, "merge"] as const)(
    "preserves authored rows without seeding %s config",
    (mode) => {
      expect(applyRequestyConfig({ models: { mode } }).models?.providers?.requesty?.models).toEqual(
        [],
      );
      const authored = {
        ...getStaticRequestyModelCatalog()[0]!,
        id: "operator-model",
        name: "My model",
      };
      const result = applyRequestyConfig({
        models: {
          mode,
          providers: { requesty: { baseUrl: REQUESTY_BASE_URL, models: [authored] } },
        },
      });
      expect(result.models?.providers?.requesty?.models).toEqual([authored]);
    },
  );
});
