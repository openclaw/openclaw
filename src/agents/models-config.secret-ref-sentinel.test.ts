import { describe, expect, it } from "vitest";
import { getCustomProviderApiKey } from "./model-auth.js";
import { REDACTED_API_KEY_SENTINEL } from "./models-config.providers.js";

describe("REDACTED_API_KEY_SENTINEL", () => {
  it("is the expected fixed value", () => {
    expect(REDACTED_API_KEY_SENTINEL).toBe("__redacted__");
  });

  it("is not a valid API key pattern", () => {
    expect(REDACTED_API_KEY_SENTINEL).not.toMatch(/^sk-/);
    expect(REDACTED_API_KEY_SENTINEL).not.toMatch(/^[A-Za-z0-9]{20,}/);
    expect(REDACTED_API_KEY_SENTINEL.length).toBeLessThan(20);
  });

  it("is truthy and trimmed (passes basic string checks)", () => {
    expect(REDACTED_API_KEY_SENTINEL).toBeTruthy();
    expect(typeof REDACTED_API_KEY_SENTINEL).toBe("string");
    expect(REDACTED_API_KEY_SENTINEL.trim()).toBe(REDACTED_API_KEY_SENTINEL);
  });
});

describe("getCustomProviderApiKey filters sentinel", () => {
  it("returns undefined when provider apiKey is the sentinel", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            apiKey: REDACTED_API_KEY_SENTINEL,
            models: [],
          },
        },
      },
    } as unknown as Parameters<typeof getCustomProviderApiKey>[0];
    expect(getCustomProviderApiKey(cfg, "openai")).toBeUndefined();
  });

  it("returns real key when provider apiKey is not the sentinel", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            apiKey: "sk-real-key-123",
            models: [],
          },
        },
      },
    } as unknown as Parameters<typeof getCustomProviderApiKey>[0];
    expect(getCustomProviderApiKey(cfg, "openai")).toBe("sk-real-key-123");
  });

  it("returns undefined when no apiKey configured", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [],
          },
        },
      },
    } as unknown as Parameters<typeof getCustomProviderApiKey>[0];
    expect(getCustomProviderApiKey(cfg, "openai")).toBeUndefined();
  });
});
