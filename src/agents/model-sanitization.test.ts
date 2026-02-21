import { describe, expect, it } from "vitest";
import {
  buildCatalogKeySet,
  sanitizeConfiguredModelIds,
  sanitizeSingleModelId,
} from "./model-sanitization.js";

describe("model-sanitization", () => {
  describe("sanitizeConfiguredModelIds", () => {
    const catalog = new Set([
      "google-antigravity/claude-opus-4-6-thinking",
      "anthropic/claude-3-5-sonnet",
      "anthropic/claude-opus-4-5",
      "openai/gpt-4o",
    ]);

    it("keeps IDs that exist in catalog", () => {
      const result = sanitizeConfiguredModelIds(
        ["anthropic/claude-3-5-sonnet", "openai/gpt-4o"],
        catalog,
      );
      expect(result.configured).toEqual(["anthropic/claude-3-5-sonnet", "openai/gpt-4o"]);
      expect(result.removed).toEqual([]);
      expect(result.repaired).toEqual([]);
      expect(result.ambiguous).toEqual([]);
      expect(result.unknown).toEqual([]);
    });

    it("repairs stale ID to -thinking variant when unambiguous", () => {
      const result = sanitizeConfiguredModelIds(["google-antigravity/claude-opus-4-6"], catalog);
      expect(result.configured).toEqual(["google-antigravity/claude-opus-4-6-thinking"]);
      expect(result.repaired).toEqual([
        {
          from: "google-antigravity/claude-opus-4-6",
          to: "google-antigravity/claude-opus-4-6-thinking",
        },
      ]);
      expect(result.removed).toEqual([]);
      expect(result.ambiguous).toEqual([]);
      expect(result.unknown).toEqual([]);
    });

    it("repairs stale ID to a single deterministic candidate even without -thinking", () => {
      const nonThinkingCatalog = new Set(["provider/model-v2"]);
      const result = sanitizeConfiguredModelIds(["provider/model"], nonThinkingCatalog);
      expect(result.configured).toEqual(["provider/model-v2"]);
      expect(result.repaired).toEqual([
        {
          from: "provider/model",
          to: "provider/model-v2",
        },
      ]);
      expect(result.removed).toEqual([]);
      expect(result.ambiguous).toEqual([]);
      expect(result.unknown).toEqual([]);
    });

    it("removes ID when multiple candidates exist (ambiguous)", () => {
      const ambiguousCatalog = new Set([
        "provider/model-thinking",
        "provider/model-fast",
        "provider/model-preview",
      ]);
      const result = sanitizeConfiguredModelIds(["provider/model"], ambiguousCatalog);
      expect(result.removed).toEqual(["provider/model"]);
      expect(result.configured).toEqual([]);
      expect(result.repaired).toEqual([]);
      expect(result.ambiguous).toEqual(["provider/model"]);
      expect(result.unknown).toEqual([]);
    });

    it("does not cross providers in repair logic", () => {
      const result = sanitizeConfiguredModelIds(["other-provider/claude-opus-4-6"], catalog);
      expect(result.removed).toEqual(["other-provider/claude-opus-4-6"]);
      expect(result.configured).toEqual([]);
      expect(result.repaired).toEqual([]);
      expect(result.ambiguous).toEqual([]);
      expect(result.unknown).toEqual(["other-provider/claude-opus-4-6"]);
    });

    it("classifies malformed IDs as unknown", () => {
      const result = sanitizeConfiguredModelIds(["noslash", "provider/"], catalog);
      expect(result.configured).toEqual([]);
      expect(result.repaired).toEqual([]);
      expect(result.ambiguous).toEqual([]);
      expect(result.unknown).toEqual(["noslash", "provider/"]);
    });

    it("is deterministic across multiple runs", () => {
      const input = [
        "google-antigravity/claude-opus-4-6",
        "anthropic/claude-3-5-sonnet",
        "nonexistent/model",
      ];
      const result1 = sanitizeConfiguredModelIds(input, catalog);
      const result2 = sanitizeConfiguredModelIds(input, catalog);
      expect(result1).toEqual(result2);
    });

    it("does not repair when base ID exactly matches", () => {
      const catalogWithExact = new Set(["provider/model", "provider/model-thinking"]);
      const result = sanitizeConfiguredModelIds(["provider/model"], catalogWithExact);
      expect(result.configured).toEqual(["provider/model"]);
      expect(result.repaired).toEqual([]);
      expect(result.ambiguous).toEqual([]);
      expect(result.unknown).toEqual([]);
    });
  });

  describe("sanitizeSingleModelId", () => {
    const catalog = new Set([
      "google-antigravity/claude-opus-4-6-thinking",
      "anthropic/claude-3-5-sonnet",
    ]);

    it("returns valid ID unchanged", () => {
      const result = sanitizeSingleModelId("anthropic/claude-3-5-sonnet", catalog);
      expect(result.id).toBe("anthropic/claude-3-5-sonnet");
      expect(result.repaired).toBeUndefined();
    });

    it("repairs and returns the repaired entry", () => {
      const result = sanitizeSingleModelId("google-antigravity/claude-opus-4-6", catalog);
      expect(result.id).toBe("google-antigravity/claude-opus-4-6-thinking");
      expect(result.repaired).toEqual({
        from: "google-antigravity/claude-opus-4-6",
        to: "google-antigravity/claude-opus-4-6-thinking",
      });
    });

    it("returns ambiguous reason when multiple candidates exist", () => {
      const result = sanitizeSingleModelId(
        "provider/model",
        new Set(["provider/model-thinking", "provider/model-preview"]),
      );
      expect(result.id).toBeNull();
      expect(result.reason).toBe("ambiguous");
    });

    it("returns unknown reason when no deterministic candidate exists", () => {
      const result = sanitizeSingleModelId("provider/missing", catalog);
      expect(result.id).toBeNull();
      expect(result.reason).toBe("unknown");
    });
  });

  describe("buildCatalogKeySet", () => {
    it("builds set from catalog entries", () => {
      const catalog = [
        { provider: "anthropic", id: "claude-3-5-sonnet" },
        { provider: "openai", id: "gpt-4o" },
      ];
      const result = buildCatalogKeySet(catalog);
      expect(result.has("anthropic/claude-3-5-sonnet")).toBe(true);
      expect(result.has("openai/gpt-4o")).toBe(true);
    });
  });
});
