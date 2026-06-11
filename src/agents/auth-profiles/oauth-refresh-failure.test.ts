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
  classifyOAuthRefreshFailureReason,
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

  it("classifies ended OpenAI app sessions as sign-in-required", () => {
    expect(classifyOAuthRefreshFailureReason("401 app_session_terminated")).toBe("sign_in_again");
    expect(classifyOAuthRefreshFailureReason("Your session has ended. Please log in again.")).toBe(
      "sign_in_again",
    );
    expect(
      classifyOAuthRefreshFailure(
        "OAuth token refresh failed for openai-codex: 401 app_session_terminated: Your session has ended. Please log in again.",
      ),
    ).toEqual({
      provider: "openai-codex",
      reason: "sign_in_again",
    });
  });
});
