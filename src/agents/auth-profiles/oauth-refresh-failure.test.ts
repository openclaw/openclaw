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

  it("classifies claude-cli subprocess 401 OAuth expiry as a provider refresh failure", () => {
    // Error message format emitted by the claude subprocess when its stored
    // OAuth token has expired, forwarded through the FailoverError message.
    const claudeCliFailureMessage =
      "Provider claude-cli failed: Failed to authenticate. API Error: 401 Invalid authentication credentials";
    expect(classifyOAuthRefreshFailure(claudeCliFailureMessage)).toEqual({
      provider: "claude-cli",
      reason: "revoked",
    });
    expect(buildOAuthRefreshFailureLoginCommand("claude-cli")).toBe(
      "openclaw models auth login --provider claude-cli",
    );
  });

  it("does not classify a 401 auth failure without claude-cli prefix as a refresh failure", () => {
    // A generic 401 from another provider should NOT be treated as an OAuth
    // refresh failure — it lacks the "claude-cli" provider prefix.
    const otherProviderMessage =
      "Provider openai failed: Failed to authenticate. API Error: 401 Unauthorized";
    expect(classifyOAuthRefreshFailure(otherProviderMessage)).toBeNull();
  });
});
