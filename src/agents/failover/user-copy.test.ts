import { describe, expect, it } from "vitest";
import { renderFormatErrorCopy } from "./assistant-request-failure-copy.js";
import {
  AUTH_INVALID_TOKEN_USER_TEXT,
  renderBillingReplyCopy,
  renderCliTimeoutReplyCopy,
  renderFailoverCodeUserCopy,
  renderHeartbeatRunFailureCopy,
  renderMissingApiKeyReplyCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
  renderSanitizedUserFacingText,
} from "./user-copy.js";

describe("failover user copy", () => {
  it.each([
    [undefined, "Troubleshooting: run `openclaw logs --follow` in a terminal."],
    ["", "Troubleshooting: run `openclaw logs --follow` in a terminal."],
    [
      "Codex session became active in another runner; wait for it to finish before continuing",
      "Details: Codex session became active in another runner; wait for it to finish before continuing.\nTroubleshooting: run `openclaw logs --follow` in a terminal.",
    ],
    [
      "Codex session became active in another runner; wait for it to finish before continuing.",
      "Details: Codex session became active in another runner; wait for it to finish before continuing.\nTroubleshooting: run `openclaw logs --follow` in a terminal.",
    ],
    [
      "Gateway SDK resource host is not bound",
      "Details: Gateway SDK resource host is not bound.\nTroubleshooting: run `openclaw logs --follow` in a terminal.",
    ],
  ])("keeps heartbeat diagnostics separate from the primary message for %j", (reason, details) => {
    expect(renderHeartbeatRunFailureCopy(reason)).toBe(
      `⚠️ The background check did not complete.\n\n${details}`,
    );
  });

  const tokenLimitCopy =
    "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.";

  it("renders only the allowlisted selected-profile code", () => {
    expect(renderFailoverCodeUserCopy("selected_auth_profile_unavailable")).toBe(
      "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.",
    );
    expect(renderFailoverCodeUserCopy("plugin_selected_profile_unavailable")).toBeUndefined();
    expect(
      renderFailoverCodeUserCopy({ code: "selected_auth_profile_unavailable" }),
    ).toBeUndefined();
  });

  it("renders transient copy from the classified reason", () => {
    const raw = "429 Too Many Requests: model overloaded";
    expect(renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw })).toBe(
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    );
    expect(renderRateLimitOrOverloadedCopy({ reason: "overloaded", raw })).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });

  it.each([
    [
      "429 rate limit: service overloaded, try again in 30 seconds",
      "⚠️ rate limit: service overloaded, try again in 30 seconds",
    ],
    [
      "All models failed (2): a/m: try again in 17 minutes (rate_limit) | b/m: 429 (rate_limit)",
      "⚠️ try again in 17 minutes",
    ],
  ])("preserves bounded provider retry detail: %s", (raw, expected) => {
    expect(renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw })).toBe(expected);
  });

  it.each([
    "Error: 400 max_tokens (384000) exceeds model's maximum output tokens (65536)",
    "OpenAI API error (400): max_output_tokens (384000) exceeds model's maximum output tokens (65536)",
    "Azure OpenAI API error (400): max_completion_tokens (384000) exceeds model's maximum output tokens (65536)",
    "OpenAI API error (400): 400 max_new_tokens (384000) exceeds model's maximum output tokens (65536)",
  ])("surfaces token limits from %s", (raw) => {
    expect(renderFormatErrorCopy(raw)).toBe(tokenLimitCopy);
  });

  it.each([
    "A maximum of 4 blocks with cache_control may be provided. Found 5. PRIVATE_CANARY",
    "A maximum of many blocks with cache_control may be provided. Found 5.",
  ])("preserves unrecognized rejection detail: %s", (raw) => {
    expect(renderFormatErrorCopy(raw)).toContain("LLM request rejected:");
    expect(renderFormatErrorCopy(raw)).toContain("A maximum of");
  });

  it("bounds provider diagnostics without dropping the cause", () => {
    const raw = `Invalid parameter: ${"x".repeat(1000)}`;
    const copy = renderFormatErrorCopy(raw);
    expect(copy).toContain("LLM request rejected: Invalid parameter");
    expect(copy).toHaveLength(624);
    expect(copy.endsWith("…")).toBe(true);
  });

  it("redacts credentials and renders provider markup as literal text", () => {
    const raw =
      "Invalid argument api_key=synthetic_secret_value; ![image](https://example.test/pixel)";
    const copy = renderFormatErrorCopy(
      JSON.stringify({
        error: { type: "invalid_request_error", message: raw },
        request: { input: "PRIVATE_PROMPT" },
      }),
    );
    expect(copy).toContain("Invalid argument");
    expect(copy).not.toContain("synthetic_secret_value");
    expect(copy).not.toContain("PRIVATE_PROMPT");
    expect(copy).not.toContain("![image](");
  });

  it.each(["{ malformed response", "<html>Private gateway response</html>", ""])(
    "does not dump an unparsed response body: %s",
    (raw) => {
      expect(renderFormatErrorCopy(raw)).toBe(
        "The AI service couldn't accept this request. Try a new conversation with /new, or choose another model in the Control UI.",
      );
    },
  );

  it("renders structured cooldown durations and exhausted model sets", () => {
    const now = 1_000_000;
    expect(
      renderRateLimitReplyCopy({
        message: "limited",
        reason: "rate_limit",
        attempts: [{ provider: "openai", model: "gpt-a", reason: "rate_limit" }],
        cooldownExpiry: now + 45_000,
        nowMs: now,
      }),
    ).toBe("⚠️ The AI service needs a short break. Please try again in ~45s.");
    expect(
      renderRateLimitReplyCopy({
        message: "limited",
        reason: "rate_limit",
        attempts: [
          { provider: "openai", model: "gpt-a", reason: "rate_limit" },
          { provider: "anthropic", model: "claude-b", reason: "overloaded" },
        ],
        nowMs: now,
      }),
    ).toBe("⚠️ The AI services are busy. Please try again in a few minutes.");
  });

  it("preserves the first bounded provider hint from structured exhausted attempts", () => {
    const attempts = [0, 1, 2].map((index) => ({
      provider: `mock${index}`,
      model: `synthetic-${"long-model-name-".repeat(10)}${index}`,
      reason: "rate_limit" as const,
      error: `Rate limit reached. Please try again in ${17 + index} minutes.`,
    }));
    expect(
      renderRateLimitReplyCopy({
        message: `All models failed (3): ${attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error} (rate_limit)`)
          .join(" | ")}`,
        reason: "rate_limit",
        attempts,
        sanitizeText: (text) => renderSanitizedUserFacingText(text, { errorContext: true }),
      }),
    ).toBe("⚠️ Rate limit reached. Please try again in 17 minutes.");
  });

  it.each([
    `Rate limit reached. Try again in 17 minutes. ${"x".repeat(301)}`,
    "<html>Rate limit reached. Try again in 17 minutes.</html>",
    "Rate limit reached",
  ])("keeps unsafe or nonspecific structured provider text generic: %s", (error) => {
    expect(
      renderRateLimitReplyCopy({
        message: "All models failed (1)",
        reason: "rate_limit",
        attempts: [{ provider: "mock", model: "model", reason: "rate_limit", error }],
      }),
    ).toBe("⚠️ The AI service needs a short break. Please try again in a few minutes.");
  });

  it("uses neutral billing copy for subscription credentials", () => {
    expect(
      renderBillingReplyCopy({
        provider: "Anthropic",
        model: "claude",
        authMode: "oauth",
      }),
    ).toBe(
      "⚠️ Anthropic (claude) returned a billing error — check your account for subscription or usage limits, then try again.",
    );
    expect(renderBillingReplyCopy({})).toBe(
      "⚠️ The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.",
    );
  });

  it("renders provider-safe missing-key guidance", () => {
    expect(renderMissingApiKeyReplyCopy({ provider: "openai", providerGuidance: true })).toContain(
      "openclaw configure",
    );
    expect(renderMissingApiKeyReplyCopy({ provider: "provider-with-secret-name" })).toBe(
      "⚠️ This AI service isn't set up yet. Sign in under Models in the Control UI or run `openclaw configure`.",
    );
  });

  it("renders typed CLI timeout context without losing partial-work warnings", () => {
    expect(
      renderCliTimeoutReplyCopy({
        message: "openai/gpt-5.6-sol: CLI exceeded timeout (90s) and was terminated",
        provider: "codex-cli",
        cliTimeout: {
          mode: "overall",
          timeoutSeconds: 90,
          observedActivity: true,
          activeToolCount: 1,
          backgroundTaskCount: 2,
        },
        replayPrevented: true,
      }),
    ).toBe(
      "⚠️ The task took too long. Some work may have completed. Check its results before trying again. Try a smaller task, or increase the task time limit in the Control UI settings.",
    );
  });

  // Session transcripts, run status, and the TUI render failed turns through this
  // renderer; the channel reply path renders the same reason-level copy from failover
  // facts, so every error grammar the harnesses emit must agree across surfaces.
  it.each([
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a38749741971a37b-SEA, request id: req_21723077dbef46fc8a554a7f511bcb2f",
    "status code 401: Incorrect API key provided",
    "401 Unauthorized: invalid api key",
  ])("renders the provider authentication copy for %j", (raw) => {
    expect(renderSanitizedUserFacingText(raw, { errorContext: true })).toBe(
      `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`,
    );
  });

  it("renders the unavailable-model copy for provider model-not-found errors", () => {
    expect(
      renderSanitizedUserFacingText(
        "unexpected status 404 Not Found: The model `gpt-x` does not exist",
        { errorContext: true },
      ),
    ).toMatch(/^⚠️ This model was not found/);
  });

  it("keeps non-401 auth text and non-error context out of the provider copy", () => {
    const forbidden = "unexpected status 403 Forbidden: insufficient permissions for this key";
    expect(renderSanitizedUserFacingText(forbidden, { errorContext: true })).toBe(forbidden);
    const unauthorized = "status code 401: Incorrect API key provided";
    expect(renderSanitizedUserFacingText(unauthorized)).toBe(unauthorized);
  });
});

describe("rate limit copy from a failover chain summary", () => {
  const aggregate =
    "All models failed (3): anthropic/claude-opus-5: You've hit your session limit · resets 6:20pm (Europe/London) (unknown) | " +
    "claude-cli/claude-sonnet-5: You've hit your session limit · resets 6:20pm (Europe/London) (unknown) | " +
    "openai/gpt-5.6-sol: Codex error: The usage limit has been reached (rate_limit)";

  it("keeps the provider reset hint when the summary exceeds the length guard", () => {
    // The summary is over the 300 char bound, so reading it whole discards a hint the
    // provider did give. The first leg is the route the user picked.
    expect(aggregate.length).toBeGreaterThan(300);
    const copy = renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: aggregate });
    expect(copy).toContain("resets 6:20pm (Europe/London)");
    expect(copy).not.toBe(
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    );
  });

  it("still falls back to the generic message when no leg carries a hint", () => {
    const copy = renderRateLimitOrOverloadedCopy({
      reason: "rate_limit",
      raw: "All models failed (2): anthropic/claude: 429 (rate_limit) | openai/gpt-5.4: 429 (rate_limit)",
    });
    expect(copy).toContain("Please try again in a few minutes");
  });
});
