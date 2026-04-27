import { describe, expect, it } from "vitest";
import { normalizeTelnyxModel, DEFAULT_TELNYX_EMBEDDING_MODEL } from "./embedding-provider.js";

describe("normalizeTelnyxModel", () => {
  it("returns default model for empty string", () => {
    expect(normalizeTelnyxModel("")).toBe(DEFAULT_TELNYX_EMBEDDING_MODEL);
  });

  it("returns default model for whitespace", () => {
    expect(normalizeTelnyxModel("   ")).toBe(DEFAULT_TELNYX_EMBEDDING_MODEL);
  });

  it("strips telnyx/ prefix", () => {
    expect(normalizeTelnyxModel("telnyx/gte-large")).toBe("gte-large");
  });

  it("passes through other models unchanged", () => {
    expect(normalizeTelnyxModel("thenlper/gte-large")).toBe("thenlper/gte-large");
  });

  it("trims whitespace", () => {
    expect(normalizeTelnyxModel("  thenlper/gte-large  ")).toBe("thenlper/gte-large");
  });

  it("default model is thenlper/gte-large", () => {
    expect(DEFAULT_TELNYX_EMBEDDING_MODEL).toBe("thenlper/gte-large");
  });
});
