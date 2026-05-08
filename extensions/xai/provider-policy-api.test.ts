import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("xai provider-policy-api", () => {
  it("returns full reasoning levels for reasoning-capable models", () => {
    const profile = resolveThinkingProfile({
      provider: "xai",
      modelId: "grok-4.3",
      reasoning: true,
    });
    expect(profile).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "low",
    });
  });

  it("returns off-only for explicitly non-reasoning models", () => {
    const profile = resolveThinkingProfile({
      provider: "xai",
      modelId: "grok-4-fast-non-reasoning",
      reasoning: false,
    });
    expect(profile).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });

  it("returns off-only for unknown models with reasoning=false", () => {
    const profile = resolveThinkingProfile({
      provider: "xai",
      modelId: "grok-unknown",
      reasoning: false,
    });
    expect(profile).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });

  it("returns full reasoning levels for unknown models with reasoning=true", () => {
    const profile = resolveThinkingProfile({
      provider: "xai",
      modelId: "grok-unknown",
      reasoning: true,
    });
    expect(profile).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "low",
    });
  });

  it("returns undefined for non-xai providers", () => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.4",
      reasoning: true,
    });
    expect(profile).toBeUndefined();
  });

  it("returns undefined for empty provider", () => {
    const profile = resolveThinkingProfile({
      provider: "",
      modelId: "grok-4.3",
      reasoning: true,
    });
    expect(profile).toBeUndefined();
  });

  it("trims whitespace in provider ids before comparing", () => {
    const profile = resolveThinkingProfile({
      provider: " xai ",
      modelId: "grok-4.3",
      reasoning: true,
    });
    expect(profile).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "low",
    });
  });

  it("handles grok-4.20-* reasoning models", () => {
    const profile = resolveThinkingProfile({
      provider: "xai",
      modelId: "grok-4.20-beta-latest-reasoning",
      reasoning: true,
    });
    expect(profile).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "low",
    });
  });

  it("handles grok-4-1-fast-reasoning models", () => {
    const profile = resolveThinkingProfile({
      provider: "xai",
      modelId: "grok-4-1-fast-reasoning",
      reasoning: true,
    });
    expect(profile).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "low",
    });
  });
});
