import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../plugins/provider-runtime.js");
vi.unmock("../../plugins/provider-runtime.runtime.js");

let isCacheTtlEligibleProvider: typeof import("./cache-ttl.js").isCacheTtlEligibleProvider;

describe("kilocode cache-ttl eligibility", () => {
  beforeEach(async () => {
    vi.doUnmock("../../plugins/provider-runtime.js");
    vi.doUnmock("../../plugins/provider-runtime.runtime.js");
    vi.resetModules();
    const { resetProviderRuntimeHookCacheForTest } =
      await import("../../plugins/provider-runtime.js");
    resetProviderRuntimeHookCacheForTest();
    ({ isCacheTtlEligibleProvider } = await import("./cache-ttl.js"));
  });

  it("allows anthropic models", () => {
    for (const modelId of ["anthropic/claude-opus-4.6", "anthropic/claude-sonnet-4"] as const) {
      expect(isCacheTtlEligibleProvider("kilocode", modelId)).toBe(true);
    }
  });

  it("is not eligible for non-anthropic models on kilocode", () => {
    expect(isCacheTtlEligibleProvider("kilocode", "openai/gpt-5")).toBe(false);
  });

  it("is case-insensitive for provider name", () => {
    for (const [provider, modelId] of [
      ["Kilocode", "anthropic/claude-opus-4.6"],
      ["KILOCODE", "Anthropic/claude-opus-4.6"],
    ] as const) {
      expect(isCacheTtlEligibleProvider(provider, modelId)).toBe(true);
    }
  });
});
