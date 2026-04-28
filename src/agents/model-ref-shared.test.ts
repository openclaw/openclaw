import { describe, expect, it } from "vitest";
import { normalizeStaticProviderModelId } from "./model-ref-shared.js";

describe("normalizeStaticProviderModelId", () => {
  it("re-adds the nvidia prefix for bare model ids", () => {
    expect(normalizeStaticProviderModelId("nvidia", "nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("does not double-prefix already prefixed models", () => {
    expect(normalizeStaticProviderModelId("nvidia", "nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("strips Google provider prefixes through the plugin manifest policy", () => {
    expect(normalizeStaticProviderModelId("google", "google/gemini-2.5-pro")).toBe(
      "gemini-2.5-pro",
    );
    expect(normalizeStaticProviderModelId("google", "models/google/gemini-3.1-flash")).toBe(
      "gemini-3-flash-preview",
    );
  });
});
