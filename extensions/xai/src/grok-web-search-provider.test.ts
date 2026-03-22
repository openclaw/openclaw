import { describe, expect, it } from "vitest";
import { __testing } from "./grok-web-search-provider.js";

describe("grok web search provider helpers", () => {
  it("prefers configured api keys and resolves grok scoped defaults", () => {
    expect(__testing.resolveGrokApiKey({ apiKey: "xai-secret" })).toBe("xai-secret");
    expect(__testing.resolveGrokModel()).toBe("grok-4-1-fast");
    expect(__testing.resolveGrokInlineCitations()).toBe(false);
  });

  it("reads grok-specific overrides from scoped config", () => {
    expect(__testing.resolveGrokModel({ model: "xai/grok-4-fast" })).toBe("xai/grok-4-fast");
    expect(__testing.resolveGrokInlineCitations({ inlineCitations: true })).toBe(true);
  });
});
