import assert from "node:assert/strict";
/**
 * Tests for config.ts — Zod schema parsing and resolveMatrixAccount.
 */
import { describe, it } from "node:test";
import { MatrixConfigSchema, resolveMatrixAccount } from "../src/config.js";

// ── Test Fixtures ────────────────────────────────────────────────────

const VALID_FULL_CONFIG = {
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.com",
      userId: "@bot:example.com",
      accessToken: "syt_abc123_xyz",
      password: "hunter2",
      encryption: true,
      deviceName: "TestDevice",
      dm: {
        policy: "open" as const,
        allowFrom: ["@admin:example.com"],
      },
      groupPolicy: "open" as const,
      groups: {
        "!room:example.com": { allow: true, requireMention: true },
      },
      groupAllowFrom: ["@admin:example.com"],
      chunkMode: "paragraph" as const,
      textChunkLimit: 2048,
      recoveryKey: "EsSZ 8bYP...",
      trustMode: "strict" as const,
      autoJoin: "always" as const,
      autoJoinAllowFrom: ["@admin:example.com"],
      replyToMode: "all" as const,
      maxMediaSize: 10_485_760,
      rateLimitTokens: 5,
      rateLimitRefillPerSec: 1,
    },
  },
};

const VALID_MINIMAL_CONFIG = {
  channels: {
    matrix: {
      homeserver: "https://matrix.example.com",
      userId: "@bot:example.com",
      accessToken: "syt_token",
    },
  },
};

describe("MatrixConfigSchema", () => {
  describe("valid full config", () => {
    it("should parse a complete valid config", () => {
      const result = MatrixConfigSchema.safeParse(VALID_FULL_CONFIG.channels.matrix);
      assert.ok(result.success, `Parse failed: ${JSON.stringify(result.error?.issues)}`);
      assert.equal(result.data.homeserver, "https://matrix.example.com");
      assert.equal(result.data.userId, "@bot:example.com");
      assert.equal(result.data.encryption, true);
      assert.equal(result.data.deviceName, "TestDevice");
      assert.equal(result.data.trustMode, "strict");
      assert.equal(result.data.autoJoin, "always");
      assert.equal(result.data.replyToMode, "all");
      assert.equal(result.data.textChunkLimit, 2048);
    });
  });

  describe("minimal config with defaults", () => {
    it("should apply defaults for omitted fields", () => {
      const result = MatrixConfigSchema.safeParse(VALID_MINIMAL_CONFIG.channels.matrix);
      assert.ok(result.success, `Parse failed: ${JSON.stringify(result.error?.issues)}`);
      const data = result.data;
      assert.equal(data.enabled, true);
      assert.equal(data.encryption, true);
      assert.equal(data.deviceName, "OpenClaw");
      assert.equal(data.trustMode, "tofu");
      assert.equal(data.autoJoin, "off");
      assert.equal(data.replyToMode, "first");
      assert.equal(data.chunkMode, "length");
      assert.equal(data.textChunkLimit, 4096);
      assert.equal(data.maxMediaSize, 52_428_800);
      assert.equal(data.rateLimitTokens, 10);
      assert.equal(data.rateLimitRefillPerSec, 2);
      assert.equal(data.groupPolicy, "allowlist");
      assert.deepEqual(data.dm, { policy: "allowlist", allowFrom: [] });
      assert.deepEqual(data.groups, {});
      assert.deepEqual(data.groupAllowFrom, []);
      assert.deepEqual(data.autoJoinAllowFrom, []);
    });
  });

  describe("homeserver normalization", () => {
    it("should strip trailing slashes from homeserver", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        homeserver: "https://matrix.example.com///",
      });
      assert.ok(result.success);
      assert.equal(result.data.homeserver, "https://matrix.example.com");
    });

    it("should strip path from homeserver URL", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        homeserver: "https://matrix.example.com/some/path",
      });
      assert.ok(result.success);
      assert.equal(result.data.homeserver, "https://matrix.example.com");
    });

    it("should reject non-HTTPS homeserver", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        homeserver: "http://matrix.example.com",
      });
      assert.ok(!result.success);
    });
  });

  describe("userId validation", () => {
    it("should accept valid Matrix user IDs", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        userId: "@bot:matrix.org",
      });
      assert.ok(result.success);
    });

    it("should reject user IDs without @", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        userId: "bot:matrix.org",
      });
      assert.ok(!result.success);
    });

    it("should reject user IDs without domain", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        userId: "@bot",
      });
      assert.ok(!result.success);
    });
  });

  describe("invalid configs", () => {
    it("should reject empty accessToken", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        accessToken: "",
      });
      assert.ok(!result.success);
    });

    it("should reject invalid enum values", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        trustMode: "yolo",
      });
      assert.ok(!result.success);
    });

    it("should reject invalid DM policy", () => {
      const result = MatrixConfigSchema.safeParse({
        ...VALID_MINIMAL_CONFIG.channels.matrix,
        dm: { policy: "invalid" },
      });
      assert.ok(!result.success);
    });
  });
});

describe("resolveMatrixAccount", () => {
  describe("valid Zod path", () => {
    it("should resolve from full config", () => {
      const resolved = resolveMatrixAccount(VALID_FULL_CONFIG);
      assert.equal(resolved.accountId, "default");
      assert.equal(resolved.homeserver, "https://matrix.example.com");
      assert.equal(resolved.userId, "@bot:example.com");
      assert.equal(resolved.accessToken, "syt_abc123_xyz");
      assert.equal(resolved.deviceName, "TestDevice");
    });

    it("should resolve from minimal config with defaults", () => {
      const resolved = resolveMatrixAccount(VALID_MINIMAL_CONFIG);
      assert.equal(resolved.accountId, "default");
      assert.equal(resolved.encryption, true);
      assert.equal(resolved.deviceName, "OpenClaw");
      assert.equal(resolved.trustMode, "tofu");
    });

    it("should accept null accountId as default", () => {
      const resolved = resolveMatrixAccount(VALID_MINIMAL_CONFIG, null);
      assert.equal(resolved.accountId, "default");
    });

    it("should accept 'default' accountId", () => {
      const resolved = resolveMatrixAccount(VALID_MINIMAL_CONFIG, "default");
      assert.equal(resolved.accountId, "default");
    });
  });

  describe("multi-account rejection", () => {
    it("should reject non-default accountId", () => {
      assert.throws(
        () => resolveMatrixAccount(VALID_MINIMAL_CONFIG, "secondary"),
        /not supported.*only a single account/,
      );
    });
  });

  describe("fallback path", () => {
    it("should fall back gracefully on missing channels.matrix", () => {
      const resolved = resolveMatrixAccount({});
      assert.equal(resolved.accountId, "default");
      assert.equal(resolved.homeserver, "");
      assert.equal(resolved.accessToken, "");
      assert.equal(resolved.deviceName, "OpenClaw");
    });

    it("should fall back on null input", () => {
      const resolved = resolveMatrixAccount(null);
      assert.equal(resolved.accountId, "default");
      assert.equal(resolved.homeserver, "");
    });

    it("should fall back on completely empty matrix config", () => {
      const resolved = resolveMatrixAccount({ channels: { matrix: {} } });
      assert.equal(resolved.accountId, "default");
      assert.equal(resolved.enabled, true);
      assert.equal(resolved.encryption, true);
    });

    it("should preserve values even when Zod validation fails", () => {
      // HTTP homeserver fails Zod's HTTPS requirement, but fallback preserves it
      const cfg = {
        channels: {
          matrix: {
            homeserver: "http://localhost:8448",
            userId: "@bot:localhost",
            accessToken: "token123",
          },
        },
      };
      const resolved = resolveMatrixAccount(cfg);
      assert.equal(resolved.accessToken, "token123");
      // Homeserver should be preserved via fallback
      assert.ok(resolved.homeserver.includes("localhost"));
    });
  });
});
