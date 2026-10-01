import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  makeSeededRandom,
  randomAsciiString as randomJunk,
  randomlyCased,
} from "./oauth-test-utils.js";
import { isRefreshTokenReusedError } from "./oauth.test-support.js";

describe("isRefreshTokenReusedError", () => {
  describe("positive cases", () => {
    it("detects when message is wrapped in a multi-level cause chain", () => {
      const root = new Error("already been used to generate a new access token");
      const mid = new Error("plugin adapter failure", { cause: root });
      const outer = new Error("OAuth token refresh failed", { cause: mid });
      expect(isRefreshTokenReusedError(outer)).toBe(true);
    });

    it("detects when cause is a bare string (no Error wrapper)", () => {
      const outer = new Error("upstream", { cause: "refresh_token_reused" });
      expect(isRefreshTokenReusedError(outer)).toBe(true);
    });
  });

  describe("negative cases", () => {
    it("returns false for unrelated auth errors", () => {
      expect(isRefreshTokenReusedError(new Error("invalid_grant"))).toBe(false);
      expect(isRefreshTokenReusedError(new Error("HTTP 500 Internal Server Error"))).toBe(false);
      expect(isRefreshTokenReusedError(new Error("network timeout"))).toBe(false);
      expect(isRefreshTokenReusedError(new Error("expired or revoked"))).toBe(false);
    });

    it("returns false for null/undefined/non-stringable values", () => {
      expect(isRefreshTokenReusedError(null)).toBe(false);
      expect(isRefreshTokenReusedError(undefined)).toBe(false);
      expect(isRefreshTokenReusedError(42)).toBe(false);
      expect(isRefreshTokenReusedError({})).toBe(false);
    });

    it("returns false for an empty error message", () => {
      expect(isRefreshTokenReusedError(new Error(""))).toBe(false);
    });
  });

  describe("fuzz: random noisy messages", () => {
    it("always detects the marker when embedded at random positions with noise", () => {
      const rng = makeSeededRandom(0xabad1dea);
      const markers = [
        "refresh_token_reused",
        "Your refresh token has already been used to generate a new access token",
        "already been used to generate a new access token",
      ];
      for (let i = 0; i < 500; i += 1) {
        const marker = randomlyCased(
          expectDefined(markers[i % markers.length], "markers[i % markers.length] test invariant"),
          rng,
        );
        const prefix = randomJunk(rng, 64);
        const suffix = randomJunk(rng, 64);
        const msg = `${prefix}${marker}${suffix}`;
        expect(isRefreshTokenReusedError(new Error(msg))).toBe(true);
        // Same for plain-string throws.
        expect(isRefreshTokenReusedError(msg)).toBe(true);
      }
    });
  });
});
