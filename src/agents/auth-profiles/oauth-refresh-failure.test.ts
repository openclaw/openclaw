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
  classifyProviderOAuthAuthenticationFailure,
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

  it("classifies Claude CLI OAuth 401 authentication failures for re-auth guidance", () => {
    expect(
      classifyProviderOAuthAuthenticationFailure({
        provider: "claude-cli",
        message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      }),
    ).toEqual({
      provider: "claude-cli",
      reason: "sign_in_again",
    });
    expect(
      classifyProviderOAuthAuthenticationFailure({
        provider: "anthropic",
        message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      }),
    ).toBeNull();
  });
});
