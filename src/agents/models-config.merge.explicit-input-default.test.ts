import { describe, expect, it } from "vitest";
import { mergeProviderModels } from "./models-config.merge.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

/**
 * Regression tests for https://github.com/openclaw/openclaw/issues/71921
 *
 * When an explicit (user config) model entry for a vision-capable family
 * lacks an `input` field, and there's no matching implicit (discovery)
 * entry to inherit from, the merge previously returned the entry unchanged.
 * Downstream `modelSupportsImages` then read `undefined` and silently
 * defaulted to text-only, permanently breaking image attachments.
 *
 * These tests lock in that explicit-only vision-capable models receive a
 * default `input: ["text", "image"]` so image attachments work out of the box.
 */

function makeProvider(models: Array<Record<string, unknown>>): ProviderConfig {
  return { models } as ProviderConfig;
}

describe("mergeProviderModels — explicit-only input defaults", () => {
  it("defaults Claude Opus 4.x without input to ['text','image']", () => {
    const implicit = makeProvider([]);
    const explicit = makeProvider([
      {
        id: "us.anthropic.claude-opus-4-7",
        name: "Claude Opus 4.7 (US)",
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    expect(merged.models).toEqual([
      expect.objectContaining({
        id: "us.anthropic.claude-opus-4-7",
        input: ["text", "image"],
      }),
    ]);
  });

  it("defaults Claude Sonnet 4.x and Haiku 4.x without input", () => {
    const implicit = makeProvider([]);
    const explicit = makeProvider([
      { id: "us.anthropic.claude-sonnet-4-6" },
      { id: "global.anthropic.claude-haiku-4-5-20251001-v1:0" },
      { id: "anthropic.claude-opus-4-6-v1" },
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    for (const m of merged.models ?? []) {
      expect((m as { input?: string[] }).input).toEqual(["text", "image"]);
    }
  });

  it("defaults GPT-4o and Gemini 1.5 families", () => {
    const implicit = makeProvider([]);
    const explicit = makeProvider([
      { id: "gpt-4o" },
      { id: "gpt-4o-mini" },
      { id: "gemini-1.5-pro" },
      { id: "gemini-2.5-pro" },
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    for (const m of merged.models ?? []) {
      expect((m as { input?: string[] }).input).toEqual(["text", "image"]);
    }
  });

  it("preserves explicit input when user specifies it", () => {
    const implicit = makeProvider([]);
    const explicit = makeProvider([
      {
        id: "us.anthropic.claude-opus-4-7",
        input: ["text"], // user explicitly wants text-only
      },
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    expect((merged.models?.[0] as { input?: string[] }).input).toEqual(["text"]);
  });

  it("does not touch non-vision model families", () => {
    const implicit = makeProvider([]);
    const explicit = makeProvider([
      { id: "titan-embed-text-v2" },
      { id: "some-custom-text-only-model" },
      { id: "claude-2" }, // pre-vision Claude
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    for (const m of merged.models ?? []) {
      expect("input" in (m as object)).toBe(false);
    }
  });

  it("still inherits from implicit when both catalogs have the model", () => {
    const implicit = makeProvider([
      {
        id: "us.anthropic.claude-opus-4-7",
        input: ["text", "image"],
        contextWindow: 1_000_000,
      },
    ]);
    const explicit = makeProvider([
      {
        id: "us.anthropic.claude-opus-4-7",
        name: "Override name",
      },
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    expect(merged.models?.[0]).toEqual(
      expect.objectContaining({
        id: "us.anthropic.claude-opus-4-7",
        name: "Override name",
        input: ["text", "image"],
        contextWindow: 1_000_000,
      }),
    );
  });
});
