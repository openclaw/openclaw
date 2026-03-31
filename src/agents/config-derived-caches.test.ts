import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateConfigDerivedCaches,
  registerConfigDerivedCache,
  resetConfigDerivedCacheRegistryForTest,
} from "./config-derived-caches.js";

describe("config-derived-caches", () => {
  beforeEach(() => {
    resetConfigDerivedCacheRegistryForTest();
  });

  afterEach(() => {
    resetConfigDerivedCacheRegistryForTest();
  });

  it("invalidates caches whose prefix matches a changed path", () => {
    const modelInvalidate = vi.fn();
    const cronInvalidate = vi.fn();

    registerConfigDerivedCache({
      name: "models",
      prefixes: ["models"],
      invalidate: modelInvalidate,
    });
    registerConfigDerivedCache({
      name: "cron",
      prefixes: ["cron"],
      invalidate: cronInvalidate,
    });

    const invalidated = invalidateConfigDerivedCaches(["models.providers.openai.models"]);

    expect(modelInvalidate).toHaveBeenCalledOnce();
    expect(cronInvalidate).not.toHaveBeenCalled();
    expect(invalidated).toEqual(["models"]);
  });

  it("invalidates caches with exact path match", () => {
    const invalidate = vi.fn();
    registerConfigDerivedCache({
      name: "test",
      prefixes: ["models"],
      invalidate,
    });

    invalidateConfigDerivedCaches(["models"]);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("does not invalidate when prefix does not match", () => {
    const invalidate = vi.fn();
    registerConfigDerivedCache({
      name: "test",
      prefixes: ["models"],
      invalidate,
    });

    invalidateConfigDerivedCaches(["cron.schedule"]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates caches with empty prefixes on any change", () => {
    const invalidate = vi.fn();
    registerConfigDerivedCache({
      name: "catch-all",
      prefixes: [],
      invalidate,
    });

    const invalidated = invalidateConfigDerivedCaches(["anything.at.all"]);

    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidated).toEqual(["catch-all"]);
  });

  it("invalidates multiple caches that share the same prefix", () => {
    const inv1 = vi.fn();
    const inv2 = vi.fn();

    registerConfigDerivedCache({
      name: "cache-a",
      prefixes: ["models"],
      invalidate: inv1,
    });
    registerConfigDerivedCache({
      name: "cache-b",
      prefixes: ["models"],
      invalidate: inv2,
    });

    const invalidated = invalidateConfigDerivedCaches(["models.providers.xai"]);

    expect(inv1).toHaveBeenCalledOnce();
    expect(inv2).toHaveBeenCalledOnce();
    expect(invalidated).toEqual(["cache-a", "cache-b"]);
  });

  it("does not match paths that merely share a common prefix substring", () => {
    const invalidate = vi.fn();
    registerConfigDerivedCache({
      name: "test",
      prefixes: ["model"],
      invalidate,
    });

    // "models.providers" starts with "model" but is NOT "model" or "model.*"
    invalidateConfigDerivedCaches(["models.providers"]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("returns empty array when no caches are invalidated", () => {
    registerConfigDerivedCache({
      name: "test",
      prefixes: ["models"],
      invalidate: vi.fn(),
    });

    const invalidated = invalidateConfigDerivedCaches(["cron.schedule"]);
    expect(invalidated).toEqual([]);
  });

  it("handles cache with multiple prefixes", () => {
    const invalidate = vi.fn();
    registerConfigDerivedCache({
      name: "multi",
      prefixes: ["models", "auth"],
      invalidate,
    });

    invalidateConfigDerivedCaches(["auth.provider"]);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
