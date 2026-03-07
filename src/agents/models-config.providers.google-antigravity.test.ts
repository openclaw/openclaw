import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeAntigravityModelId,
  normalizeProviders,
  type ProviderConfig,
} from "./models-config.providers.js";

function buildModel(id: string): NonNullable<ProviderConfig["models"]>[number] {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
}

function buildProvider(modelIds: string[]): ProviderConfig {
  return {
    baseUrl: "https://example.invalid/v1",
    api: "openai-completions",
    apiKey: "EXAMPLE_KEY",
    models: modelIds.map((id) => buildModel(id)),
  };
}

describe("normalizeAntigravityModelId", () => {
  it.each(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"])(
    "adds default -low suffix to bare pro id: %s",
    (id) => {
      expect(normalizeAntigravityModelId(id)).toBe(`${id}-low`);
    },
  );

  it.each([
    "gemini-3-pro-low",
    "gemini-3-pro-high",
    "gemini-3.1-flash",
    "claude-opus-4-6-thinking",
  ])("keeps already-tiered and non-pro ids unchanged: %s", (id) => {
    expect(normalizeAntigravityModelId(id)).toBe(id);
  });
});

describe("google-antigravity provider normalization", () => {
  it("normalizes bare gemini pro IDs only for google-antigravity providers", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      "google-antigravity": buildProvider([
        "gemini-3-pro",
        "gemini-3.1-pro",
        "gemini-3-1-pro",
        "gemini-3-pro-high",
        "claude-opus-4-6-thinking",
      ]),
      openai: buildProvider(["gpt-5"]),
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized).not.toBe(providers);
    expect(normalized?.["google-antigravity"]?.models.map((model) => model.id)).toEqual([
      "gemini-3-pro-low",
      "gemini-3.1-pro-low",
      "gemini-3-1-pro-low",
      "gemini-3-pro-high",
      "claude-opus-4-6-thinking",
    ]);
    expect(normalized?.openai).toBe(providers.openai);
  });

  it("returns original providers object when no antigravity IDs need normalization", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      "google-antigravity": buildProvider(["gemini-3-pro-low", "claude-opus-4-6-thinking"]),
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized).toBe(providers);
  });
});
