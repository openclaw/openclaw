import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";

describe("isModernModelRef", () => {
  it("keeps antigravity modern set on gemini-3 only", () => {
    expect(isModernModelRef({ provider: "google-antigravity", id: "gemini-3-pro-high" })).toBe(
      true,
    );
    expect(isModernModelRef({ provider: "google-antigravity", id: "gemini-3-flash" })).toBe(true);
    expect(
      isModernModelRef({ provider: "google-antigravity", id: "claude-opus-4-6-thinking" }),
    ).toBe(false);
  });
});
