// Covers fallback-only context-cache precedence independently of runtime warmup.
import { describe, expect, it } from "vitest";
import { providerContextTokenCacheKey } from "./context-cache.js";
import { applyDiscoveredContextWindows } from "./context.js";

describe("applyDiscoveredContextWindows fallback mode", () => {
  it("keeps discovered keys while collapsing duplicate static-only rows conservatively", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "model-a", provider: "provider-a", contextTokens: 900_000 },
        {
          id: "provider-a/model-b",
          provider: "provider-a",
          contextTokens: 800_000,
        },
      ],
    });
    applyDiscoveredContextWindows({
      cache,
      mode: "fallback",
      models: [
        { id: "model-a", provider: "provider-a", contextWindow: 64_000 },
        { id: "model-a", provider: "provider-a", contextWindow: 32_000 },
        { id: "provider-a/model-b", provider: "provider-a", contextWindow: 64_000 },
        { id: "offline", provider: "provider-a", contextWindow: 128_000 },
        { id: "offline", provider: "provider-a", contextWindow: 64_000 },
      ],
    });

    expect(cache.get("model-a")).toBe(900_000);
    expect(cache.get(providerContextTokenCacheKey("provider-a", "model-a"))).toBe(900_000);
    expect(cache.get("provider-a/model-b")).toBe(800_000);
    expect(cache.get("model-b")).toBeUndefined();
    expect(cache.get(providerContextTokenCacheKey("provider-a", "model-b"))).toBe(800_000);
    expect(cache.get("offline")).toBe(64_000);
    expect(cache.get(providerContextTokenCacheKey("provider-a", "offline"))).toBe(64_000);
  });
});
