import assert from "node:assert/strict";
/**
 * Tests for targets.ts — target resolution.
 *
 * Tests the prefix stripping and routing logic of resolveMatrixTarget.
 * The @user and #alias paths require matrixFetch (network), so we test
 * them as far as the synchronous path allows and verify the !roomId
 * passthrough and prefix stripping logic thoroughly.
 */
import { describe, it } from "node:test";
import { resolveMatrixTarget } from "../src/client/targets.js";

const OWN_USER_ID = "@bot:example.com";

describe("resolveMatrixTarget", () => {
  describe("!roomId direct passthrough", () => {
    it("should pass through room IDs unchanged", async () => {
      const result = await resolveMatrixTarget("!abc123:example.com", OWN_USER_ID);
      assert.equal(result, "!abc123:example.com");
    });

    it("should handle room IDs with various characters", async () => {
      const result = await resolveMatrixTarget("!aBcDeF_123-456:matrix.org", OWN_USER_ID);
      assert.equal(result, "!aBcDeF_123-456:matrix.org");
    });
  });

  describe("prefix stripping", () => {
    it("should strip matrix: prefix from room IDs", async () => {
      const result = await resolveMatrixTarget("matrix:!room:example.com", OWN_USER_ID);
      assert.equal(result, "!room:example.com");
    });

    it("should strip room: prefix", async () => {
      const result = await resolveMatrixTarget("room:!myroom:example.com", OWN_USER_ID);
      assert.equal(result, "!myroom:example.com");
    });

    it("should strip channel: prefix", async () => {
      const result = await resolveMatrixTarget("channel:!myroom:example.com", OWN_USER_ID);
      assert.equal(result, "!myroom:example.com");
    });

    it("should be case-insensitive for prefixes", async () => {
      const result = await resolveMatrixTarget("MATRIX:!room:example.com", OWN_USER_ID);
      assert.equal(result, "!room:example.com");
    });

    it("should strip matrix: then room: prefix combined", async () => {
      const result = await resolveMatrixTarget("matrix:room:!r:e.com", OWN_USER_ID);
      assert.equal(result, "!r:e.com");
    });

    it("should handle whitespace around target", async () => {
      const result = await resolveMatrixTarget("  !room:example.com  ", OWN_USER_ID);
      assert.equal(result, "!room:example.com");
    });
  });

  describe("invalid target handling", () => {
    it("should throw on empty target", async () => {
      await assert.rejects(() => resolveMatrixTarget("", OWN_USER_ID), /target is required/);
    });

    it("should throw on whitespace-only target", async () => {
      await assert.rejects(() => resolveMatrixTarget("   ", OWN_USER_ID), /target is required/);
    });

    it("should return raw string for non-prefixed non-sigil target", async () => {
      // Unrecognized strings are passed through as-is (assumed room ID)
      const result = await resolveMatrixTarget("some-random-string", OWN_USER_ID);
      assert.equal(result, "some-random-string");
    });
  });

  describe("@user:server resolution (requires network)", () => {
    // These tests verify the routing happens correctly.
    // The actual DM resolution requires matrixFetch and would fail without a server.
    it("should attempt DM resolution for @user targets", async () => {
      // This will fail because no HTTP client is initialized, but we can
      // verify the error message indicates DM resolution was attempted.
      await assert.rejects(
        () => resolveMatrixTarget("@friend:example.com", OWN_USER_ID),
        // Should fail at the HTTP layer, not at target parsing
        (err: Error) => {
          // Either "HTTP client not initialized" or "No DM room found"
          return (
            err.message.includes("client not initialized") ||
            err.message.includes("No DM room found")
          );
        },
      );
    });

    it("should strip user: prefix before @user resolution", async () => {
      await assert.rejects(
        () => resolveMatrixTarget("user:@friend:example.com", OWN_USER_ID),
        (err: Error) => {
          return (
            err.message.includes("client not initialized") ||
            err.message.includes("No DM room found")
          );
        },
      );
    });
  });

  describe("#alias:server resolution (requires network)", () => {
    it("should attempt alias resolution for #alias targets", async () => {
      await assert.rejects(
        () => resolveMatrixTarget("#general:example.com", OWN_USER_ID),
        // Should fail at the HTTP layer
        (err: Error) => {
          return (
            err.message.includes("client not initialized") ||
            err.message.includes("could not be resolved")
          );
        },
      );
    });

    it("should strip channel: prefix before #alias resolution", async () => {
      await assert.rejects(
        () => resolveMatrixTarget("channel:#general:example.com", OWN_USER_ID),
        (err: Error) => {
          return (
            err.message.includes("client not initialized") ||
            err.message.includes("could not be resolved")
          );
        },
      );
    });
  });
});
