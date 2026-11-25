import { describe, expect, it } from "vitest";
import {
  clampOpenAIPromptCacheKey,
  resolveOpenAIPromptCacheLifetimeMs,
  resolveOpenAIPromptCacheParams,
} from "./openai-prompt-cache.js";

const native = { provider: "openai", baseUrl: "https://api.openai.com/v1" };
const lifetimeCompat = { supportsPromptCacheKey: true, supportsLongCacheRetention: true };

describe("clampOpenAIPromptCacheKey", () => {
  it.each([
    ["absent", undefined],
    ["at the cap", "a".repeat(64)],
    ["astral over the cap", "🦞".repeat(74)],
  ] as const)("preserves the 64-code-point contract: %s", (_name, key) => {
    expect(clampOpenAIPromptCacheKey(key)).toBe(
      key === undefined ? undefined : Array.from(key).slice(0, 64).join(""),
    );
  });
});

describe("OpenAI prompt-cache lifetime", () => {
  it("adds the prewarm flag beside the lifetime the request already sends", () => {
    const model = { ...native, id: "gpt-6.1-sol" };
    expect(resolveOpenAIPromptCacheParams(model, "long", lifetimeCompat, undefined, true)).toEqual({
      prompt_cache_options: { ttl: "30m", prewarm: true },
    });
    expect(resolveOpenAIPromptCacheParams(model, "short", lifetimeCompat, undefined, true)).toEqual(
      {
        prompt_cache_options: { prewarm: true },
      },
    );
  });

  it.each([
    ["native 5.6+ default", { ...native, id: "gpt-6.1-sol" }, "short", undefined, 30 * 60_000],
    ["native 5.6+ requested", { ...native, id: "gpt-5.6-sol" }, "long", undefined, 30 * 60_000],
    ["12 hours requested", { ...native, id: "gpt-6.1-sol" }, "long", "12h", 12 * 60 * 60_000],
    [
      "proxy without a lifetime field",
      { provider: "proxy", baseUrl: "https://proxy.example/v1", id: "gpt-6.1-sol" },
      "short",
      undefined,
      undefined,
    ],
    ["earlier model", { ...native, id: "gpt-5.5" }, "long", undefined, undefined],
    ["caching off", { ...native, id: "gpt-6.1-sol" }, "none", undefined, undefined],
  ] as const)(
    "knows only documented minimum lifetimes: %s",
    (_name, model, retention, ttl, expected) => {
      expect(resolveOpenAIPromptCacheLifetimeMs(model, retention, lifetimeCompat, ttl)).toBe(
        expected,
      );
    },
  );
});
