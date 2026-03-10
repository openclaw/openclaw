import { describe, expect, it } from "vitest";
import {
  getOpencodeGoStaticFallbackModels,
  OPENCODE_GO_DEFAULT_MODEL_REF,
  resolveOpencodeGoAlias,
  resolveOpencodeGoModelApi,
} from "./opencode-go-models.js";

describe("opencode-go-models", () => {
  it("resolves aliases without affecting unknown values", () => {
    expect(resolveOpencodeGoAlias("kimi")).toBe("kimi-k2.5");
    expect(resolveOpencodeGoAlias("glm")).toBe("glm-5");
    expect(resolveOpencodeGoAlias("m2")).toBe("minimax-m2.5");
    expect(resolveOpencodeGoAlias("custom-model")).toBe("custom-model");
  });

  it("routes Kimi and GLM through OpenAI-compatible chat completions", () => {
    expect(resolveOpencodeGoModelApi("kimi-k2.5")).toBe("openai-completions");
    expect(resolveOpencodeGoModelApi("glm-5")).toBe("openai-completions");
  });

  it("routes MiniMax through Anthropic messages", () => {
    expect(resolveOpencodeGoModelApi("minimax-m2.5")).toBe("anthropic-messages");
  });

  it("provides a compact fallback catalog with the expected default", () => {
    const models = getOpencodeGoStaticFallbackModels();
    expect(models.map((model) => model.id)).toEqual(["kimi-k2.5", "glm-5", "minimax-m2.5"]);
    expect(OPENCODE_GO_DEFAULT_MODEL_REF).toBe("opencode-go/kimi-k2.5");
  });
});
