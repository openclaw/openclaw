// Model Catalog Core tests cover model catalog refs behavior.
import { describe, expect, it } from "vitest";
import {
  buildModelCatalogMergeKey,
  buildModelCatalogRef,
  parseModelCatalogRef,
} from "./model-catalog-refs.js";

describe("model catalog refs", () => {
  it("normalizes provider ids without lowercasing model ids in refs", () => {
    expect(buildModelCatalogRef("OpenAI", "GPT-5.4")).toBe("openai/GPT-5.4");
    expect(buildModelCatalogMergeKey("OpenAI", "GPT-5.4")).toBe("openai::gpt-5.4");
  });

  it("parses strict refs while preserving nested model ids", () => {
    expect(parseModelCatalogRef(" OpenRouter / meta-llama/llama-3.3 ")).toEqual({
      provider: "openrouter",
      modelId: "meta-llama/llama-3.3",
    });
  });

  it.each(["", "openai", "/gpt-5.4", "openai/", " / gpt-5.4 "])(
    "rejects incomplete ref %j",
    (value) => {
      expect(parseModelCatalogRef(value)).toBeNull();
    },
  );
});
