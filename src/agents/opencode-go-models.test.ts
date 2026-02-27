import { describe, expect, it } from "vitest";
import {
  getOpencodeGoStaticFallbackModels,
  OPENCODE_GO_MODEL_ALIASES,
  resolveOpencodeGoAlias,
  resolveOpencodeGoModelApi,
} from "./opencode-go-models.js";

describe("resolveOpencodeGoAlias", () => {
  it("resolves glm alias", () => {
    expect(resolveOpencodeGoAlias("glm")).toBe("glm-5");
  });

  it("resolves minimax alias", () => {
    expect(resolveOpencodeGoAlias("minimax")).toBe("minimax-m2.5");
  });

  it("resolves kimi alias", () => {
    expect(resolveOpencodeGoAlias("kimi")).toBe("kimi-k2.5");
  });

  it("returns input if no alias exists", () => {
    expect(resolveOpencodeGoAlias("some-unknown-model")).toBe("some-unknown-model");
  });

  it("is case-insensitive", () => {
    expect(resolveOpencodeGoAlias("GLM")).toBe("glm-5");
    expect(resolveOpencodeGoAlias("Kimi")).toBe("kimi-k2.5");
  });
});

describe("resolveOpencodeGoModelApi", () => {
  it("maps APIs by model family", () => {
    expect(resolveOpencodeGoModelApi("minimax-m2.5")).toBe("openai-completions");
    expect(resolveOpencodeGoModelApi("glm-5")).toBe("openai-completions");
    expect(resolveOpencodeGoModelApi("kimi-k2.5")).toBe("openai-completions");
    expect(resolveOpencodeGoModelApi("some-unknown-model")).toBe("openai-completions");
  });
});

describe("getOpencodeGoStaticFallbackModels", () => {
  it("returns an array of models", () => {
    const models = getOpencodeGoStaticFallbackModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBe(3);
  });

  it("includes GLM, MiniMax, and Kimi models", () => {
    const models = getOpencodeGoStaticFallbackModels();
    const ids = models.map((m) => m.id);

    expect(ids).toContain("glm-5");
    expect(ids).toContain("minimax-m2.5");
    expect(ids).toContain("kimi-k2.5");
  });

  it("returns valid ModelDefinitionConfig objects", () => {
    const models = getOpencodeGoStaticFallbackModels();
    for (const model of models) {
      expect(model.id).toBeDefined();
      expect(model.name).toBeDefined();
      expect(typeof model.reasoning).toBe("boolean");
      expect(Array.isArray(model.input)).toBe(true);
      expect(model.cost).toBeDefined();
      expect(typeof model.contextWindow).toBe("number");
      expect(typeof model.maxTokens).toBe("number");
    }
  });
});

describe("OPENCODE_GO_MODEL_ALIASES", () => {
  it("has expected aliases", () => {
    expect(OPENCODE_GO_MODEL_ALIASES.glm).toBe("glm-5");
    expect(OPENCODE_GO_MODEL_ALIASES.minimax).toBe("minimax-m2.5");
    expect(OPENCODE_GO_MODEL_ALIASES.kimi).toBe("kimi-k2.5");
    expect(OPENCODE_GO_MODEL_ALIASES["glm-5"]).toBe("glm-5");
    expect(OPENCODE_GO_MODEL_ALIASES["minimax-m2.5"]).toBe("minimax-m2.5");
    expect(OPENCODE_GO_MODEL_ALIASES["kimi-k2.5"]).toBe("kimi-k2.5");
  });
});
