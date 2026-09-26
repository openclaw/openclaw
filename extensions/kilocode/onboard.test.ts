import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  buildKilocodeModelDefinition,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MODEL_ID,
} from "./api.js";
import { applyKilocodeConfig, KILOCODE_DEFAULT_MODEL_REF } from "./onboard.js";
import { KILOCODE_BASE_URL } from "./provider-models.js";

describe("Kilo Gateway provider config", () => {
  it("builds the public default model definition", () => {
    const model = buildKilocodeModelDefinition();
    expect(model.id).toBe(KILOCODE_DEFAULT_MODEL_ID);
    expect(model.name).toBe("Auto Balanced");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(KILOCODE_DEFAULT_CONTEXT_WINDOW);
    expect(model.maxTokens).toBe(KILOCODE_DEFAULT_MAX_TOKENS);
    expect(model.cost).toEqual(KILOCODE_DEFAULT_COST);
  });

  it("seeds the default model in replace mode", () => {
    const result = applyKilocodeConfig({ models: { mode: "replace" } });
    expect(result.models?.providers?.kilocode?.models.map((model) => model.id)).toEqual([
      "kilo-auto/balanced",
    ]);
  });

  it.each([undefined, "merge"] as const)(
    "preserves authored rows without seeding %s config",
    (mode) => {
      expect(applyKilocodeConfig({ models: { mode } }).models?.providers?.kilocode?.models).toEqual(
        [],
      );
      const authored = {
        ...buildKilocodeModelDefinition(),
        id: "operator-model",
        name: "My model",
      };
      const result = applyKilocodeConfig({
        models: {
          mode,
          providers: { kilocode: { baseUrl: KILOCODE_BASE_URL, models: [authored] } },
        },
      });
      expect(result.models?.providers?.kilocode?.models).toEqual([authored]);
    },
  );

  it("sets up the Kilo Gateway default for a new config", () => {
    const result = applyKilocodeConfig({});
    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
      "kilocode/kilo-auto/balanced",
    );
    expect(result.agents?.defaults?.models?.[KILOCODE_DEFAULT_MODEL_REF]).toEqual({
      alias: "Kilo Gateway",
    });
    expect(result.models?.providers?.kilocode).toMatchObject({
      baseUrl: "https://api.kilo.ai/api/gateway/",
      api: "openai-completions",
    });
  });
});
