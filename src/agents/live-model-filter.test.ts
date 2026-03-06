import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";

describe("isModernModelRef", () => {
  it("recognizes openai-codex/gpt-5.4 as a modern codex model", () => {
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.4" })).toBe(true);
  });
});
