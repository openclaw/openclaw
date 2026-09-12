import { describe, expect, it } from "vitest";
import { resolveConfiguredModelEntries } from "./configured-model-entries.js";

describe("resolveConfiguredModelEntries", () => {
  it("parses configured models without loading provider-runtime normalization", () => {
    const { entries } = resolveConfiguredModelEntries({
      allowPluginNormalization: false,
      cfg: {
        agents: {
          defaults: {
            model: { primary: "codex/gpt-5.5", fallbacks: ["codex/gpt-5.4-mini"] },
            models: {
              "codex/gpt-5.5": { alias: "Codex" },
              "codex/gpt-5.4-mini": {},
            },
          },
        },
        models: { providers: {} },
      },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["codex/gpt-5.5", "codex/gpt-5.4-mini"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
    expect(entries[0]?.aliases).toEqual(["Codex"]);
    expect(entries[1]?.tags).toEqual(new Set(["fallback#1", "configured"]));
  });

  it("normalizes retired nested Gemini ids in configured provider rows", () => {
    const { entries } = resolveConfiguredModelEntries({
      allowPluginNormalization: false,
      cfg: {
        agents: {
          defaults: {
            model: { primary: "kilocode/google/gemini-3-pro-preview" },
            models: {
              "kilocode/google/gemini-3-pro-preview": { alias: "Kilo Gemini" },
            },
          },
        },
        models: {
          providers: {
            kilocode: {
              api: "openai-completions",
              baseUrl: "https://kilocode.test/v1",
              models: [
                {
                  id: "google/gemini-3-pro-preview",
                  name: "Gemini 3 Pro",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["kilocode/google/gemini-3.1-pro-preview"]);
    expect(entries[0]?.aliases).toEqual(["Kilo Gemini"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
  });
  it("treats provider wildcard defaults as selectors, not configured model rows", () => {
    const { entries } = resolveConfiguredModelEntries({
      allowPluginNormalization: false,
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            models: {
              "openai/*": {},
              "openai/gpt-5.5": { alias: "Primary" },
            },
          },
        },
        models: { providers: {} },
      },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["openai/gpt-5.5"]);
    expect(entries[0]?.aliases).toEqual(["Primary"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
  });

  it("preserves aliases and roles when provider references are canonicalized", () => {
    const { entries } = resolveConfiguredModelEntries({
      cfg: {
        agents: {
          defaults: {
            model: "legacy/model",
            models: { "legacy/model": { alias: "Work" } },
          },
        },
      },
      allowPluginNormalization: false,
      canonicalizeRef: (ref) => ({ ...ref, provider: "current" }),
    });
    expect(entries.map((entry) => entry.key)).toEqual(["current/model"]);
    expect(entries[0]?.aliases).toEqual(["Work"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
  });
});
