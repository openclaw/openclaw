import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeGoogleModelId } from "./model-id-normalization.js";
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
    apiKey: "EXAMPLE_KEY", // pragma: allowlist secret
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

describe("normalizeGoogleModelId", () => {
  it("maps the deprecated 3.1 flash shorthand to the real preview model", () => {
    expect(normalizeGoogleModelId("gemini-3.1-flash")).toBe("gemini-3-flash-preview");
  });

  it("passes gemini-3.1-flash-preview through unchanged (it is now a real model ID)", () => {
    expect(normalizeGoogleModelId("gemini-3.1-flash-preview")).toBe("gemini-3.1-flash-preview");
  });

  it("adds the preview suffix for gemini 3.1 flash-lite", () => {
    expect(normalizeGoogleModelId("gemini-3.1-flash-lite")).toBe("gemini-3.1-flash-lite-preview");
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

describe("google-vertex provider normalization", () => {
  it("normalizes gemini flash-lite IDs for google-vertex providers", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      "google-vertex": buildProvider(["gemini-3.1-flash-lite", "gemini-3-flash-preview"]),
      openai: buildProvider(["gpt-5"]),
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized).not.toBe(providers);
    expect(normalized?.["google-vertex"]?.models.map((model) => model.id)).toEqual([
      "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
    ]);
    expect(normalized?.openai).toBe(providers.openai);
  });

  it("returns original providers object when no google-vertex IDs need normalization", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      "google-vertex": buildProvider(["gemini-3.1-flash-lite-preview", "gemini-3-flash-preview"]),
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized).toBe(providers);
  });
});
