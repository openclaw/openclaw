import { describe, expect, it } from "vitest";
import { normalizeGoogleModelId } from "./models-config.providers.js";

describe("normalizeGoogleModelId", () => {
  it("normalizes gemini-3-pro to gemini-3-pro-preview", () => {
    expect(normalizeGoogleModelId("gemini-3-pro")).toBe("gemini-3-pro-preview");
  });

  it("normalizes gemini-3-flash to gemini-3-flash-preview", () => {
    expect(normalizeGoogleModelId("gemini-3-flash")).toBe("gemini-3-flash-preview");
  });

  it("normalizes gemini-3.1-pro to gemini-3.1-pro-preview", () => {
    expect(normalizeGoogleModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview");
  });

  it("returns unknown ids unchanged", () => {
    expect(normalizeGoogleModelId("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  it("returns already-preview ids unchanged", () => {
    expect(normalizeGoogleModelId("gemini-3-pro-preview")).toBe("gemini-3-pro-preview");
    expect(normalizeGoogleModelId("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
  });
});
