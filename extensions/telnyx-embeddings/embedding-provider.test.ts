import { describe, expect, it } from "vitest";
import { normalizeTelnyxModel, DEFAULT_TELNYX_EMBEDDING_MODEL } from "./embedding-provider.js";

describe("normalizeTelnyxModel", () => {
  it("returns default model for empty string", () => {
    expect(normalizeTelnyxModel("")).toBe(DEFAULT_TELNYX_EMBEDDING_MODEL);
  });

  it("returns default model for whitespace", () => {
    expect(normalizeTelnyxModel("   ")).toBe(DEFAULT_TELNYX_EMBEDDING_MODEL);
  });

  it("passes through fully-qualified models unchanged", () => {
    expect(normalizeTelnyxModel("thenlper/gte-large")).toBe("thenlper/gte-large");
  });

  it("passes through multilingual model unchanged", () => {
    expect(normalizeTelnyxModel("intfloat/multilingual-e5-large")).toBe(
      "intfloat/multilingual-e5-large",
    );
  });

  it("passes through Qwen model unchanged", () => {
    expect(normalizeTelnyxModel("Qwen/Qwen3-Embedding-8B")).toBe("Qwen/Qwen3-Embedding-8B");
  });

  it("trims whitespace", () => {
    expect(normalizeTelnyxModel("  thenlper/gte-large  ")).toBe("thenlper/gte-large");
  });

  it("default model is thenlper/gte-large", () => {
    expect(DEFAULT_TELNYX_EMBEDDING_MODEL).toBe("thenlper/gte-large");
  });
});
