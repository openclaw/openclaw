import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";

describe("isModernModelRef — xAI Grok families", () => {
  it("recognises grok-4 variants (existing)", () => {
    expect(isModernModelRef({ provider: "xai", id: "grok-4" })).toBe(true);
    expect(isModernModelRef({ provider: "xai", id: "grok-4-1-fast" })).toBe(true);
    expect(isModernModelRef({ provider: "xai", id: "grok-4-fast" })).toBe(true);
  });

  it("recognises grok-3 variants (fix #15709)", () => {
    expect(isModernModelRef({ provider: "xai", id: "grok-3" })).toBe(true);
    expect(isModernModelRef({ provider: "xai", id: "grok-3-fast" })).toBe(true);
    expect(isModernModelRef({ provider: "xai", id: "grok-3-mini" })).toBe(true);
    expect(isModernModelRef({ provider: "xai", id: "grok-3-mini-fast" })).toBe(true);
  });

  it("recognises grok-2 variants (fix #15709)", () => {
    expect(isModernModelRef({ provider: "xai", id: "grok-2" })).toBe(true);
    expect(isModernModelRef({ provider: "xai", id: "grok-2-1212" })).toBe(true);
    expect(isModernModelRef({ provider: "xai", id: "grok-2-vision-1212" })).toBe(true);
  });

  it("rejects non-xai providers", () => {
    expect(isModernModelRef({ provider: "openai", id: "grok-3" })).toBe(false);
    expect(isModernModelRef({ provider: "anthropic", id: "grok-4" })).toBe(false);
  });

  it("rejects empty/null refs", () => {
    expect(isModernModelRef({ provider: "", id: "grok-3" })).toBe(false);
    expect(isModernModelRef({ provider: "xai", id: "" })).toBe(false);
    expect(isModernModelRef({})).toBe(false);
  });

  it("still recognises other modern providers", () => {
    expect(isModernModelRef({ provider: "anthropic", id: "claude-sonnet-4-6" })).toBe(true);
    expect(isModernModelRef({ provider: "google", id: "gemini-3-pro" })).toBe(true);
  });
});
