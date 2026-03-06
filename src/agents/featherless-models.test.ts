import { describe, expect, it } from "vitest";
import {
  buildFeatherlessModelDefinition,
  FEATHERLESS_MODEL_CATALOG,
} from "./featherless-models.js";

describe("featherless-models", () => {
  it("buildFeatherlessModelDefinition returns config with required fields", () => {
    const entry = FEATHERLESS_MODEL_CATALOG[0];
    const def = buildFeatherlessModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.api).toBe("openai-completions");
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(entry.input);
    expect(def.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("all catalog entries have zero cost (flat-rate pricing)", () => {
    for (const entry of FEATHERLESS_MODEL_CATALOG) {
      expect(entry.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("catalog contains at least one model", () => {
    expect(FEATHERLESS_MODEL_CATALOG.length).toBeGreaterThanOrEqual(1);
  });
});
