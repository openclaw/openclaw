import { describe, expect, it } from "vitest";
import {
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureReason,
} from "./oauth-refresh-failure.js";

describe("classifyOAuthRefreshFailureReason", () => {
  it("classifies ended OpenAI app sessions as sign-in-required", () => {
    expect(classifyOAuthRefreshFailureReason("401 app_session_terminated")).toBe("sign_in_again");
    expect(classifyOAuthRefreshFailureReason("Your session has ended. Please log in again.")).toBe(
      "sign_in_again",
    );
  });
});

describe("classifyOAuthRefreshFailure", () => {
  it("extracts provider and reason from app-session-terminated refresh failures", () => {
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
