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

  it("recognises external CLI subprocess 401 expiry (claude-cli) as a refresh failure", () => {
    // The `claude` CLI, spawned under CLAUDE_CLI_CLEAR_ENV, emits its own 401
    // message on OAuth token expiry. This must classify as a refresh failure so
    // the operator gets the re-auth hint instead of a generic "something went
    // wrong" error (see issue #97553).
    expect(
      classifyOAuthRefreshFailure(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ).toEqual({
      provider: null,
      reason: "revoked",
    });
  });

  it("does not classify a bare 401 as a refresh failure", () => {
    // A network 401 without the "failed to authenticate" signal must not be
    // promoted to an OAuth refresh failure — guards against mis-hinting on
    // unrelated 401 responses from other surfaces.
    expect(classifyOAuthRefreshFailure("Request failed with status 401")).toBeNull();
    expect(classifyOAuthRefreshFailureReason("Request failed with status 401")).toBeNull();
  });
});
