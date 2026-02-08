import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveCompactModelRef } from "./compact.js";

function makeConfig(compact?: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: compact ? { primary: "anthropic/claude-sonnet-4-5", compact } : undefined,
      },
    },
  } as unknown as OpenClawConfig;
}

describe("resolveCompactModelRef", () => {
  it("returns caller model when no config is provided", () => {
    const result = resolveCompactModelRef({
      callerProvider: "anthropic",
      callerModel: "claude-sonnet-4-5",
    });
    expect(result).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  it("returns caller model when config has no model.compact", () => {
    const cfg = { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } } };
    const result = resolveCompactModelRef({
      config: cfg as unknown as OpenClawConfig,
      callerProvider: "anthropic",
      callerModel: "claude-sonnet-4-5",
    });
    expect(result).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  it("parses provider/model from compact config", () => {
    const result = resolveCompactModelRef({
      config: makeConfig("google/gemini-3-flash-preview"),
      callerProvider: "anthropic",
      callerModel: "claude-sonnet-4-5",
    });
    expect(result).toEqual({ provider: "google", modelId: "gemini-3-flash-preview" });
  });

  it("uses caller provider when compact config has no slash", () => {
    const result = resolveCompactModelRef({
      config: makeConfig("gemini-3-flash-preview"),
      callerProvider: "google-gemini-cli",
      callerModel: "gemini-3-pro-preview",
    });
    expect(result).toEqual({ provider: "google-gemini-cli", modelId: "gemini-3-flash-preview" });
  });

  it("trims whitespace from compact config", () => {
    const result = resolveCompactModelRef({
      config: makeConfig("  google/gemini-3-flash-preview  "),
      callerProvider: "anthropic",
      callerModel: "claude-sonnet-4-5",
    });
    expect(result).toEqual({ provider: "google", modelId: "gemini-3-flash-preview" });
  });

  it("ignores empty compact config string", () => {
    const result = resolveCompactModelRef({
      config: makeConfig("   "),
      callerProvider: "anthropic",
      callerModel: "claude-sonnet-4-5",
    });
    expect(result).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  it("falls back to default provider when callerProvider is missing", () => {
    const result = resolveCompactModelRef({
      config: makeConfig("gemini-3-flash-preview"),
    });
    // DEFAULT_PROVIDER is used when callerProvider is undefined
    expect(result.modelId).toBe("gemini-3-flash-preview");
    expect(result.provider).toBeTruthy();
  });

  it("falls back to default model when callerModel is missing and no compact config", () => {
    const result = resolveCompactModelRef({});
    expect(result.provider).toBeTruthy();
    expect(result.modelId).toBeTruthy();
  });
});
