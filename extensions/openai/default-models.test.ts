// Openai tests cover default models plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyOpenAIConfig, applyOpenAIProviderConfig, OPENAI_DEFAULT_MODEL } from "./api.js";

describe("openai default models", () => {
  it("adds allowlist entry for the default model", () => {
    const next = applyOpenAIProviderConfig({});
    expect(Object.keys(next.agents?.defaults?.models ?? {})).toEqual([OPENAI_DEFAULT_MODEL]);
    expect(next.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]).toEqual({ alias: "GPT" });
  });

  it("preserves existing alias for the default model", () => {
    const next = applyOpenAIProviderConfig({
      agents: {
        defaults: {
          models: {
            [OPENAI_DEFAULT_MODEL]: { alias: "My GPT" },
          },
        },
      },
    });
    expect(next.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]?.alias).toBe("My GPT");
  });

  it("does not duplicate a case-insensitive custom GPT alias", () => {
    const next = applyOpenAIProviderConfig({
      agents: {
        defaults: {
          modelPolicy: { allow: ["custom/model", "openai/*"] },
          models: {
            "custom/model": { alias: "gPt" },
          },
        },
      },
    });

    expect(next.agents?.defaults?.models?.["custom/model"]?.alias).toBe("gPt");
    expect(next.agents?.defaults?.models?.[OPENAI_DEFAULT_MODEL]).toEqual({});
  });

  it("sets Sol as the API-key default when it is unset", () => {
    const next = applyOpenAIConfig({});
    expect(next.agents?.defaults?.model).toEqual({ primary: "openai/gpt-6.1-sol" });
  });

  it("preserves an explicit primary and its fallbacks", () => {
    const next = applyOpenAIConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] } } },
    } as OpenClawConfig);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: [],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-opus-4-6": {},
      [OPENAI_DEFAULT_MODEL]: { alias: "GPT" },
    });
  });

  it("fills a missing object-form primary while preserving fallbacks", () => {
    const next = applyOpenAIConfig({
      agents: { defaults: { model: { fallbacks: ["anthropic/claude-opus-4-6"] } } },
    } as OpenClawConfig);

    expect(next.agents?.defaults?.model).toEqual({
      primary: OPENAI_DEFAULT_MODEL,
      fallbacks: ["anthropic/claude-opus-4-6"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-opus-4-6": {},
      [OPENAI_DEFAULT_MODEL]: { alias: "GPT" },
    });
  });
  it.each([
    { modelPolicy: { allow: ["openai/gpt-6-astra"] } },
    { models: { "openai/gpt-6-astra": {} } },
  ])("does not widen a restriction to select the new default", (defaults) => {
    const config: OpenClawConfig = { agents: { defaults } };
    expect(applyOpenAIProviderConfig(config)).toEqual(config);
    expect(applyOpenAIConfig(config)).toEqual(config);
  });
  it("preserves a permitted implicit default under an agent-owned restriction", () => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { modelPolicy: { allow: ["openai/gpt-6-astra"] } } } },
    };
    expect(applyOpenAIConfig(config)).toEqual(config);
  });

  it("does not let an independently selected agent block a permitted new default", () => {
    const research = {
      model: { primary: "openai/gpt-6-astra" },
      modelPolicy: { allow: ["openai/gpt-6-astra"] },
    };
    const next = applyOpenAIConfig({ agents: { entries: { main: {}, research } } });
    expect(next.agents?.defaults?.model).toEqual({ primary: "openai/gpt-6.1-sol" });
    expect(next.agents?.entries?.research).toEqual(research);
  });
});
