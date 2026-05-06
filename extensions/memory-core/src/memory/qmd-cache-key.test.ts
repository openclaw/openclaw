import { describe, expect, it } from "vitest";
import { buildQmdCacheKey } from "./qmd-cache-key.js";

const baseConfig = {
  command: "qmd",
  collections: [],
  searchMode: "query",
} as unknown as Parameters<typeof buildQmdCacheKey>[1];

describe("buildQmdCacheKey", () => {
  it("differs by agentId", () => {
    expect(buildQmdCacheKey("a1", baseConfig)).not.toBe(buildQmdCacheKey("a2", baseConfig));
  });

  it("differs by userId when provided", () => {
    expect(buildQmdCacheKey("a1", baseConfig, "alice")).not.toBe(
      buildQmdCacheKey("a1", baseConfig, "bob"),
    );
  });

  it("treats userId=undefined as the legacy unscoped key", () => {
    const legacy = buildQmdCacheKey("a1", baseConfig);
    const explicitUndef = buildQmdCacheKey("a1", baseConfig, undefined);
    expect(legacy).toBe(explicitUndef);
  });

  it("scoped key never collides with unscoped key for same agent", () => {
    expect(buildQmdCacheKey("a1", baseConfig)).not.toBe(
      buildQmdCacheKey("a1", baseConfig, "alice"),
    );
  });

  it("is deterministic for identical inputs", () => {
    expect(buildQmdCacheKey("a1", baseConfig, "alice")).toBe(
      buildQmdCacheKey("a1", baseConfig, "alice"),
    );
  });
});
