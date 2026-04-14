import { describe, expect, it } from "vitest";
import { DiscoveryCache } from "./cache.js";
import type { AdpDiscoveryResult } from "./types.js";

const sampleResult: AdpDiscoveryResult = {
  format: "adp",
  domain: "example.com",
  version: "0.1",
  services: [{ name: "memory" }],
  raw: { agent_discovery_version: "0.1", services: [{ name: "memory" }] },
};

describe("DiscoveryCache", () => {
  it("stores and retrieves a positive entry", () => {
    const cache = new DiscoveryCache(60_000);
    cache.setPositive("example.com", sampleResult, 1_000);
    const entry = cache.get("example.com", 5_000);
    expect(entry?.kind).toBe("positive");
    if (entry?.kind === "positive") {
      expect(entry.result.domain).toBe("example.com");
    }
  });

  it("stores and retrieves a negative entry", () => {
    const cache = new DiscoveryCache(60_000);
    cache.setNegative("example.com", 1_000);
    const entry = cache.get("example.com", 5_000);
    expect(entry?.kind).toBe("negative");
  });

  it("expires entries past TTL", () => {
    const cache = new DiscoveryCache(10_000);
    cache.setPositive("example.com", sampleResult, 1_000);
    expect(cache.get("example.com", 12_000)).toBeUndefined();
  });

  it("returns undefined for unknown domain", () => {
    const cache = new DiscoveryCache(60_000);
    expect(cache.get("never-set.example.com")).toBeUndefined();
  });

  it("removes expired entry on access", () => {
    const cache = new DiscoveryCache(10_000);
    cache.setNegative("a.example.com", 1_000);
    cache.get("a.example.com", 12_000);
    expect(cache.size()).toBe(0);
  });

  it("clears all entries", () => {
    const cache = new DiscoveryCache(60_000);
    cache.setPositive("a.example.com", sampleResult);
    cache.setPositive("b.example.com", sampleResult);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
