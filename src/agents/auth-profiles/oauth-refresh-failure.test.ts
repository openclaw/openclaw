/**
 * Tests OAuth refresh failure hints.
 * Verifies typed and message-based classification plus sanitized login command
 * generation.
 */
import { describe, expect, it } from "vitest";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";

describe("oauth refresh failure hints", () => {
  it("builds OpenAI refresh-failure login hints", () => {
    expect(
      classifyOAuthRefreshFailure("OAuth token refresh failed for openai: invalid_grant"),
    ).toEqual({
      provider: "openai",
      reason: "invalid_grant",
    });
    expect(buildOAuthRefreshFailureLoginCommand("openai")).toBe(
      "openclaw models auth login --provider openai",
    );
  });

  it("includes the profile id in refresh-failure login hints when known", () => {
    expect(
      buildOAuthRefreshFailureLoginCommand("openai", {
        profileId: "openai:user@example.com",
      }),
    ).toBe("openclaw models auth login --provider openai --profile-id openai:user@example.com");
  });

  it("classifies typed refresh failures without parsing the display message", () => {
    expect(
      classifyOAuthRefreshFailureError(
        new OAuthRefreshFailureError({
          provider: "openai",
          message: "invalid_grant",
        }),
      ),
    ).toEqual({
      provider: "openai",
      reason: "invalid_grant",
    });
  });

  it("retains a safe profile id from typed refresh failures", () => {
    expect(
      classifyOAuthRefreshFailureError(
        new OAuthRefreshFailureError({
          provider: "openai",
          profileId: "openai:user@example.com",
          message: "invalid_grant",
        }),
      ),
    ).toEqual({
      provider: "openai",
      reason: "invalid_grant",
      profileId: "openai:user@example.com",
    });
  });

  it("classifies token invalidation refresh failures", () => {
    expect(
      classifyOAuthRefreshFailure(
        "OAuth token refresh failed for openai: token_invalidated. Please sign in again.",
      ),
    ).toEqual({
      provider: "openai",
      reason: "token_invalidated",
    });
  });
});
