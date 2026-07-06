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
  formatOAuthRefreshFailureLoginCommandMarkdown,
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
        profileId: "Work Profile",
      }),
    ).toBe("openclaw models auth login --provider openai --profile-id 'Work Profile'");
  });

  it("renders login commands containing backticks as valid Markdown code spans", () => {
    const command = buildOAuthRefreshFailureLoginCommand("openai", {
      profileId: "openai:work`slot",
    });

    expect(formatOAuthRefreshFailureLoginCommandMarkdown(command)).toBe(
      "``openclaw models auth login --provider openai --profile-id 'openai:work`slot'``",
    );
  });

  it("classifies typed refresh failures without parsing the display message", () => {
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
      profileId: "openai:user@example.com",
      reason: "invalid_grant",
    });
  });

  it("classifies typed refresh failures through wrapper causes", () => {
    const refreshError = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: "openai:user@example.com",
      message: "invalid_grant",
    });

    expect(classifyOAuthRefreshFailureError(new Error("wrapped", { cause: refreshError }))).toEqual(
      {
        provider: "openai",
        profileId: "openai:user@example.com",
        reason: "invalid_grant",
      },
    );
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
