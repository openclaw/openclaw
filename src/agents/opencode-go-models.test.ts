import { describe, expect, it } from "vitest";
import {
  buildOpencodeGoModelDefinition,
  OPENCODE_GO_DEFAULT_MODEL_REF,
  OPENCODE_GO_MODEL_CATALOG,
} from "./opencode-go-models.js";

describe("opencode-go-models", () => {
  it("exports the documented Go catalog", () => {
    expect(OPENCODE_GO_MODEL_CATALOG.map((model) => model.id)).toEqual([
      "glm-5",
      "kimi-k2.5",
      "minimax-m2.5",
    ]);
    expect(OPENCODE_GO_DEFAULT_MODEL_REF).toBe("opencode-go/kimi-k2.5");
  });

  it("uses provider-specific APIs per model", () => {
    expect(buildOpencodeGoModelDefinition("glm-5").api).toBe("openai-completions");
    expect(buildOpencodeGoModelDefinition("kimi-k2.5").api).toBe("openai-completions");
    expect(buildOpencodeGoModelDefinition("minimax-m2.5").api).toBe("anthropic-messages");
  });
});
