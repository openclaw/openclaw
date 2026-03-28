import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import type { FeishuConfig } from "./types.js";

function createFeishuConfig(overrides: Partial<FeishuConfig>): FeishuConfig {
  return FeishuConfigSchema.parse(overrides);
}

describe("resolveFeishuGroupConfig - Issue #56338 regression tests", () => {
  describe("prefix normalization", () => {
    it("should match when config key has no prefix but groupId has chat: prefix", () => {
      const cfg = createFeishuConfig({
        groups: {
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "chat:oc_xxxxxx",
      });

      expect(resolved).toEqual({ requireMention: false });
    });

    it("should match when config key has no prefix but groupId has group: prefix", () => {
      const cfg = createFeishuConfig({
        groups: {
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "group:oc_xxxxxx",
      });

      expect(resolved).toEqual({ requireMention: false });
    });

    it("should match when config key has no prefix but groupId has feishu: prefix", () => {
      const cfg = createFeishuConfig({
        groups: {
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "feishu:oc_xxxxxx",
      });

      expect(resolved).toEqual({ requireMention: false });
    });

    it("should preserve backward compatibility: exact match takes precedence", () => {
      const cfg = createFeishuConfig({
        groups: {
          "chat:oc_xxxxxx": {
            requireMention: true, // Different value
          },
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      // Exact match should win
      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "chat:oc_xxxxxx",
      });

      expect(resolved).toEqual({ requireMention: true });
    });

    it("should handle combined prefixes", () => {
      const cfg = createFeishuConfig({
        groups: {
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "feishu:chat:oc_xxxxxx",
      });

      expect(resolved).toEqual({ requireMention: false });
    });
  });

  describe("case insensitivity", () => {
    it("should match case-insensitively after normalization", () => {
      const cfg = createFeishuConfig({
        groups: {
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "CHAT:OC_XXXXXX",
      });

      expect(resolved).toEqual({ requireMention: false });
    });
  });

  describe("wildcard fallback", () => {
    it("should fallback to wildcard when no match found", () => {
      const cfg = createFeishuConfig({
        groups: {
          "*": {
            requireMention: true,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "chat:oc_unknown",
      });

      expect(resolved).toEqual({ requireMention: true });
    });

    it("should prefer specific match over wildcard", () => {
      const cfg = createFeishuConfig({
        groups: {
          "*": {
            requireMention: true,
          },
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "chat:oc_xxxxxx",
      });

      expect(resolved).toEqual({ requireMention: false });
    });
  });

  describe("edge cases", () => {
    it("should match when config key has chat: prefix but groupId has no prefix (reverse direction)", () => {
      const cfg = createFeishuConfig({
        groups: {
          "chat:oc_xxxxxx": {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "oc_xxxxxx",
      });

      expect(resolved).toEqual({ requireMention: false });
    });

    it("should handle groupId with leading/trailing spaces", () => {
      const cfg = createFeishuConfig({
        groups: {
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "  chat:oc_xxxxxx  ",
      });

      expect(resolved).toEqual({ requireMention: false });
    });

    it("should return undefined for empty groupId", () => {
      const cfg = createFeishuConfig({
        groups: {
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: "",
      });

      expect(resolved).toBeUndefined();
    });

    it("should return undefined for null groupId", () => {
      const cfg = createFeishuConfig({
        groups: {
          oc_xxxxxx: {
            requireMention: false,
          },
        },
      });

      const resolved = resolveFeishuGroupConfig({
        cfg,
        groupId: null,
      });

      expect(resolved).toBeUndefined();
    });
  });
});
