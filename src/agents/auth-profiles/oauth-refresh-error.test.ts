import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  makeSeededRandom,
  randomAsciiString as randomJunk,
  randomlyCased,
} from "./oauth-test-utils.js";
import { isRefreshTokenReusedError } from "./oauth.test-support.js";

describe("isRefreshTokenReusedError", () => {
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
