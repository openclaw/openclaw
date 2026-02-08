import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";

describe("isModernModelRef", () => {
  it("accepts anthropic claude-opus-4-6", () => {
    expect(isModernModelRef({ provider: "anthropic", id: "claude-opus-4-6" })).toBe(true);
  });

  it("accepts anthropic claude-opus-4-5", () => {
    expect(isModernModelRef({ provider: "anthropic", id: "claude-opus-4-5" })).toBe(true);
  });

  it("accepts github-copilot claude-opus-4.6", () => {
    expect(isModernModelRef({ provider: "github-copilot", id: "claude-opus-4.6" })).toBe(true);
  });

  it("accepts github-copilot claude-opus-4.5", () => {
    expect(isModernModelRef({ provider: "github-copilot", id: "claude-opus-4.5" })).toBe(true);
  });

  it("accepts github-copilot claude-sonnet-4.5", () => {
    expect(isModernModelRef({ provider: "github-copilot", id: "claude-sonnet-4.5" })).toBe(true);
  });

  it("accepts github-copilot claude-sonnet-4", () => {
    expect(isModernModelRef({ provider: "github-copilot", id: "claude-sonnet-4" })).toBe(true);
  });

  it("accepts github-copilot gpt-5", () => {
    expect(isModernModelRef({ provider: "github-copilot", id: "gpt-5" })).toBe(true);
  });

  it("accepts github-copilot gpt-5.2-codex", () => {
    expect(isModernModelRef({ provider: "github-copilot", id: "gpt-5.2-codex" })).toBe(true);
  });

  it("rejects github-copilot with old model ids", () => {
    expect(isModernModelRef({ provider: "github-copilot", id: "o1-mini" })).toBe(false);
  });

  it("rejects empty provider or id", () => {
    expect(isModernModelRef({ provider: "", id: "claude-opus-4-6" })).toBe(false);
    expect(isModernModelRef({ provider: "anthropic", id: "" })).toBe(false);
  });
});
