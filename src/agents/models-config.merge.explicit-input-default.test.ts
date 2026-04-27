import { describe, expect, it } from "vitest";
import { mergeProviderModels, mergeProviders } from "./models-config.merge.js";
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
      { id: "llama-3.2-1b-instruct" }, // text-only small Llama
      { id: "llama-3.2-3b-instruct" }, // text-only small Llama
      { id: "fo1-embed" }, // bare 'o1' substring must NOT match
      { id: "us.amazon.nova-pro-o4-v1:0" }, // bare 'o4' substring must NOT match
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    for (const m of merged.models ?? []) {
      expect("input" in (m as object)).toBe(false);
    }
  });

  it("still flags genuine Llama vision variants", () => {
    const implicit = makeProvider([]);
    const explicit = makeProvider([
      { id: "llama-3.2-11b-vision-instruct" },
      { id: "llama-3.2-90b-vision" },
      { id: "llama-4-scout-vision" },
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    for (const m of merged.models ?? []) {
      expect((m as { input?: string[] }).input).toEqual(["text", "image"]);
    }
  });

  it("flags OpenAI o-series at token boundaries only", () => {
    const implicit = makeProvider([]);
    const explicit = makeProvider([
      { id: "o1" },
      { id: "o1-mini" },
      { id: "o3-pro" },
      { id: "openai/o4-mini" },
    ]);
    const merged = mergeProviderModels(implicit, explicit);
    for (const m of merged.models ?? []) {
      expect((m as { input?: string[] }).input).toEqual(["text", "image"]);
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

describe("mergeProviders — applies defaults to brand-new providers", () => {
  it("defaults input for a provider that has no implicit (discovery) entry", () => {
    // Simulates a user declaring a provider entirely in openclaw.json that
    // discovery never returns (e.g. discovery is off, or this provider has
    // no dynamic-catalog support). Previously these entries bypassed the
    // merge path entirely and were returned verbatim.
    const merged = mergeProviders({
      implicit: {},
      explicit: {
        "custom-anthropic": makeProvider([
          { id: "claude-opus-4-7", name: "Opus via custom backend" },
        ]),
      },
    });
    expect((merged["custom-anthropic"]?.models?.[0] as { input?: string[] })?.input).toEqual([
      "text",
      "image",
    ]);
  });
});
