import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";

describe("isModernModelRef", () => {
  it("accepts new openai gpt-5.4 refs", () => {
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-pro" })).toBe(true);
  });

  it("keeps rejecting older openai refs outside the allowlist", () => {
    expect(isModernModelRef({ provider: "openai", id: "gpt-4.1" })).toBe(false);
  });
});
