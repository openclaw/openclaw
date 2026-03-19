import { describe, expect, it } from "vitest";
import { __testing, buildAnthropicWebSearchServerTool } from "./anthropic-web-search-provider.js";

const { resolveAnthropicWebSearchConfig, resolveToolVersion, DEFAULT_TOOL_VERSION } = __testing;

describe("resolveAnthropicWebSearchConfig", () => {
  it("returns empty object when no config", () => {
    expect(resolveAnthropicWebSearchConfig(undefined)).toEqual({});
    expect(resolveAnthropicWebSearchConfig({})).toEqual({});
  });

  it("returns empty object for non-object anthropic value", () => {
    expect(resolveAnthropicWebSearchConfig({ anthropic: "invalid" } as any)).toEqual({});
    expect(resolveAnthropicWebSearchConfig({ anthropic: [] } as any)).toEqual({});
  });

  it("passes through anthropic config object", () => {
    const config = { anthropic: { maxUses: 5, allowedDomains: ["example.com"] } };
    expect(resolveAnthropicWebSearchConfig(config as any)).toEqual({
      maxUses: 5,
      allowedDomains: ["example.com"],
    });
  });
});

describe("resolveToolVersion", () => {
  it("defaults to latest version", () => {
    expect(resolveToolVersion({})).toBe(DEFAULT_TOOL_VERSION);
  });

  it("accepts valid versions", () => {
    expect(resolveToolVersion({ toolVersion: "web_search_20250305" })).toBe("web_search_20250305");
    expect(resolveToolVersion({ toolVersion: "web_search_20260209" })).toBe("web_search_20260209");
  });

  it("falls back to default for invalid versions", () => {
    expect(resolveToolVersion({ toolVersion: "invalid" })).toBe(DEFAULT_TOOL_VERSION);
    expect(resolveToolVersion({ toolVersion: "  " })).toBe(DEFAULT_TOOL_VERSION);
  });
});

describe("buildAnthropicWebSearchServerTool", () => {
  it("builds minimal tool with defaults", () => {
    const tool = buildAnthropicWebSearchServerTool();
    expect(tool).toEqual({
      type: DEFAULT_TOOL_VERSION,
      name: "web_search",
    });
  });

  it("includes allowed_domains when configured", () => {
    const tool = buildAnthropicWebSearchServerTool({
      anthropic: { allowedDomains: ["example.com", "docs.dev"] },
    } as any);
    expect(tool.allowed_domains).toEqual(["example.com", "docs.dev"]);
  });

  it("includes blocked_domains when configured", () => {
    const tool = buildAnthropicWebSearchServerTool({
      anthropic: { blockedDomains: ["spam.com"] },
    } as any);
    expect(tool.blocked_domains).toEqual(["spam.com"]);
  });

  it("includes max_uses when positive", () => {
    const tool = buildAnthropicWebSearchServerTool({
      anthropic: { maxUses: 3 },
    } as any);
    expect(tool.max_uses).toBe(3);
  });

  it("excludes max_uses when zero or negative", () => {
    expect(
      buildAnthropicWebSearchServerTool({ anthropic: { maxUses: 0 } } as any).max_uses,
    ).toBeUndefined();
    expect(
      buildAnthropicWebSearchServerTool({ anthropic: { maxUses: -1 } } as any).max_uses,
    ).toBeUndefined();
  });

  it("includes user_location when configured", () => {
    const tool = buildAnthropicWebSearchServerTool({
      anthropic: {
        userLocation: {
          type: "approximate",
          city: "Denver",
          region: "Colorado",
          country: "US",
          timezone: "America/Denver",
        },
      },
    } as any);
    expect(tool.user_location).toEqual({
      type: "approximate",
      city: "Denver",
      region: "Colorado",
      country: "US",
      timezone: "America/Denver",
    });
  });

  it("omits user_location when empty", () => {
    const tool = buildAnthropicWebSearchServerTool({
      anthropic: { userLocation: {} },
    } as any);
    expect(tool.user_location).toBeUndefined();
  });

  it("respects custom tool version", () => {
    const tool = buildAnthropicWebSearchServerTool({
      anthropic: { toolVersion: "web_search_20250305" },
    } as any);
    expect(tool.type).toBe("web_search_20250305");
  });

  it("omits empty allowed_domains array", () => {
    const tool = buildAnthropicWebSearchServerTool({
      anthropic: { allowedDomains: [] },
    } as any);
    expect(tool.allowed_domains).toBeUndefined();
  });
});
