import { describe, expect, it } from "vitest";
import { normalizeGoogleModelId } from "./models-config.providers.js";

describe("normalizeGoogleModelId", () => {
  it("maps gemini-3-pro to gemini-3-pro-preview", () => {
    expect(normalizeGoogleModelId("gemini-3-pro")).toBe("gemini-3-pro-preview");
  });

  it("maps gemini-3-flash to gemini-3-flash-preview", () => {
    expect(normalizeGoogleModelId("gemini-3-flash")).toBe("gemini-3-flash-preview");
  });

  it("maps gemini-3.1-pro to gemini-3.1-pro-preview", () => {
    expect(normalizeGoogleModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview");
  });

  it("passes through already-qualified model ids", () => {
    expect(normalizeGoogleModelId("gemini-3-pro-preview")).toBe("gemini-3-pro-preview");
    expect(normalizeGoogleModelId("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
  });

  it("passes through unknown model ids unchanged", () => {
    expect(normalizeGoogleModelId("gemini-4-ultra")).toBe("gemini-4-ultra");
  });
});
