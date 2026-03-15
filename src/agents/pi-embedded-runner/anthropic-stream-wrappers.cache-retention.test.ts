import { describe, expect, it } from "vitest";
import { resolveCacheRetention } from "./anthropic-stream-wrappers.js";

describe("resolveCacheRetention", () => {
  it("returns 'short' by default for anthropic provider", () => {
    expect(resolveCacheRetention(undefined, "anthropic")).toBe("short");
  });

  it("returns 'short' by default for cloudflare-ai-gateway provider", () => {
    expect(resolveCacheRetention(undefined, "cloudflare-ai-gateway")).toBe("short");
  });

  it("returns undefined for unrelated providers", () => {
    expect(resolveCacheRetention(undefined, "openai")).toBeUndefined();
    expect(resolveCacheRetention(undefined, "openrouter")).toBeUndefined();
  });

  it("returns explicit cacheRetention for cloudflare-ai-gateway", () => {
    expect(resolveCacheRetention({ cacheRetention: "long" }, "cloudflare-ai-gateway")).toBe("long");
    expect(resolveCacheRetention({ cacheRetention: "none" }, "cloudflare-ai-gateway")).toBe("none");
  });

  it("returns undefined for amazon-bedrock without explicit override", () => {
    expect(resolveCacheRetention(undefined, "amazon-bedrock")).toBeUndefined();
  });

  it("returns explicit cacheRetention for amazon-bedrock when overridden", () => {
    expect(resolveCacheRetention({ cacheRetention: "short" }, "amazon-bedrock")).toBe("short");
  });

  it("maps legacy cacheControlTtl values", () => {
    expect(resolveCacheRetention({ cacheControlTtl: "5m" }, "anthropic")).toBe("short");
    expect(resolveCacheRetention({ cacheControlTtl: "1h" }, "anthropic")).toBe("long");
    expect(resolveCacheRetention({ cacheControlTtl: "5m" }, "cloudflare-ai-gateway")).toBe("short");
  });
});
