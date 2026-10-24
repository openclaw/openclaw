import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "../embedded-agent-helpers/sanitize-user-facing-text.js";
import { renderFormatErrorCopy } from "./assistant-request-failure-copy.js";
import {
  AUTH_INVALID_TOKEN_USER_TEXT,
  renderBillingReplyCopy as billingCopy,
  renderCliTimeoutReplyCopy,
  renderFailoverCodeUserCopy as codeCopy,
  renderMissingApiKeyReplyCopy as missingKeyCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
  renderSanitizedUserFacingText as sanitizedCopy,
} from "./user-copy.js";

describe("failover user copy", () => {
  const retryCopy = "⚠️ The AI service needs a short break. Please try again in a few minutes.";
  const promptCopy =
    "⚠️ The provider rejected this request because the prompt exceeds its per-request limit. Shorten the prompt and try again, or choose a model with a larger limit.";
  const promptMessage =
    "This prompt is longer than the free tier allows for a single request. Shorten it, or add credits to use this model without the free-tier cap.";
  const rate = (raw: string) => renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw });
  const reply = (fields: Partial<Parameters<typeof renderRateLimitReplyCopy>[0]>) =>
    renderRateLimitReplyCopy({ message: "limited", reason: "rate_limit", ...fields });
  const http400 = (size: number, message = promptMessage) =>
    `400 ${JSON.stringify({ error: { type: "invalid_request_error", message }, request_id: "req_prompt_size_canary", details: "x".repeat(size) })}`;
  it.each([
    ["Weekly usage limit exhausted; resets 2026-10-20 00:00:00 UTC.", false],
    ["Weekly usage limit exhausted; resets 2026-10-20 00:00:00 UTC.", true],
    ["您已达到每周/每月使用上限，您的限额将在 2026-10-20 00:00:00 重置。", false],
    ["您已达到每周/每月使用上限，您的限额将在 2026-10-20 00:00:00 重置。", true],
  ])("extracts quota reset guidance: %s (structured=%s)", (message, structured) => {
    const raw = structured
      ? `429 ${JSON.stringify({ error: { message }, request: { input: "PRIVATE_REQUEST_CANARY" } })}`
      : `429 ${message}`;
    expect(
      reply({
        message: "All models failed (2)",
        reason: "overloaded",
        attempts: [
          { provider: "zai", model: "fixture", reason: "rate_limit", error: raw },
          { provider: "fallback", model: "fixture", reason: "overloaded", error: "overloaded" },
        ],
        sanitizeText: (text) => sanitizeUserFacingText(text, { errorContext: true }),
      }),
    ).toBe(`⚠️ ${message}`);
  });

  it("renders only the allowlisted selected-profile code", () => {
    expect(codeCopy("selected_auth_profile_unavailable")).toBe(
      "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.",
    );
    expect(codeCopy("plugin_selected_profile_unavailable")).toBeUndefined();
    expect(codeCopy({ code: "selected_auth_profile_unavailable" })).toBeUndefined();
  });

  it("uses neutral billing copy for subscription credentials", () => {
    expect(billingCopy({ provider: "Anthropic", model: "claude", authMode: "oauth" })).toBe(
      "⚠️ Anthropic (claude) returned a billing error — check your account for subscription or usage limits, then try again.",
    );
    expect(billingCopy({})).toBe(
      "⚠️ The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.",
    );
  });

  it("keeps already rendered billing copy classified as billing", () => {
    for (const authMode of [undefined, "oauth"] as const) {
      const stored = `${billingCopy({ provider: "openrouter", model: "moonshotai/kimi-k3", authMode })} | 402`;
      expect(sanitizedCopy(stored, { errorContext: true })).toBe(billingCopy({}));
    }
  });

  it("renders provider-safe missing-key guidance", () => {
    expect(missingKeyCopy({ provider: "openai", providerGuidance: true })).toContain(
      "openclaw configure",
    );
    expect(missingKeyCopy({ provider: "provider-with-secret-name" })).toBe(
      "⚠️ This AI service isn't set up yet. Sign in under Models in the Control UI or run `openclaw configure`.",
    );
  });

  it("renders transient copy from the classified reason", () => {
    const raw = "429 Too Many Requests: model overloaded";
    expect(rate(raw)).toBe(retryCopy);
    expect(renderRateLimitOrOverloadedCopy({ reason: "overloaded", raw })).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });

  it.each([
    [`400 ${promptMessage}`, promptCopy],
    [
      http400(16_384, "This prompt is longer than the free tier allows for a single request."),
      retryCopy,
    ],
  ])("renders prompt-size policy for %s", (raw, expected) => {
    expect(rate(raw)).toBe(expected);
  });

  it("parses a complete bounded HTTP 400 JSON body in both failover and reply copy", () => {
    const raw = http400(700);
    // 700 bytes of padding keeps this above the old 512-byte truncation boundary.
    expect([rate(raw), reply({ message: raw })]).toEqual([promptCopy, promptCopy]);
  });

  it.each([
    [
      "OpenAI API error (400): 400 max_new_tokens (384000) exceeds model's maximum output tokens (65536)",
      "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.",
    ],
    ...["{ malformed response", "<html>Private gateway response</html>"].map((raw) => [
      raw,
      "The AI service couldn't accept this request. Try a new conversation with /new, or choose another model in the Control UI.",
    ]),
  ])("renders bounded format-error copy: %s", (raw, expected) => {
    expect(renderFormatErrorCopy(raw)).toBe(expected);
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
    expect(copy).not.toMatch(/synthetic_secret_value|PRIVATE_PROMPT|!\[image\]\(/);
  });

  const firstAttempt = { provider: "openai", model: "gpt-a", reason: "rate_limit" } as const;
  const secondAttempt = { provider: "anthropic", model: "claude-b", reason: "overloaded" } as const;
  it.each([
    [[firstAttempt], 1_045_000, "⚠️ The AI service needs a short break. Please try again in ~45s."],
    [
      [firstAttempt, secondAttempt],
      undefined,
      "⚠️ The AI services are busy. Please try again in a few minutes.",
    ],
  ] as const)("renders cooldown/exhaustion: %j", (attempts, cooldownExpiry, expected) => {
    expect(reply({ attempts, cooldownExpiry, nowMs: 1_000_000 })).toBe(expected);
  });

  it("preserves the first bounded provider hint from structured exhausted attempts", () => {
    const attempts = [0, 1, 2].map((index) => ({
      provider: `mock${index}`,
      model: `synthetic-${"long-model-name-".repeat(10)}${index}`,
      reason: "rate_limit" as const,
      error: `Rate limit reached. Please try again in ${17 + index} minutes.`,
    }));
    expect(
      reply({
        message: `All models failed (3): ${attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error} (rate_limit)`)
          .join(" | ")}`,
        attempts,
      }),
    ).toBe("⚠️ Rate limit reached. Please try again in 17 minutes.");
  });

  it.each([
    `Rate limit reached. Try again in 17 minutes. ${"x".repeat(301)}`,
    "<html>Rate limit reached. Try again in 17 minutes.</html>",
  ])("keeps unsafe or nonspecific structured provider text generic: %s", (error) => {
    expect(
      reply({
        message: "All models failed (1)",
        attempts: [{ provider: "mock", model: "model", reason: "rate_limit", error }],
      }),
    ).toBe(retryCopy);
  });

  it("renders typed CLI timeout context without losing partial-work warnings", () => {
    expect(
      renderCliTimeoutReplyCopy({
        message: "openai/gpt-5.6-sol: CLI exceeded timeout (90s) and was terminated",
        cliTimeout: {
          mode: "overall",
          timeoutSeconds: 90,
          observedActivity: true,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      }),
    ).toBe(
      "⚠️ The task took too long. Some work may have completed. Check its results before trying again. Try a smaller task, or increase the task time limit in the Control UI settings.",
    );
  });

  const forbidden = "unexpected status 403 Forbidden: insufficient permissions for this key";
  const unauthorized = "status code 401: Incorrect API key provided";
  it.each([
    [
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a38749741971a37b-SEA, request id: req_21723077dbef46fc8a554a7f511bcb2f",
      true,
      `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`,
    ],
    ["401 Unauthorized: invalid api key", true, `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`],
    [
      "unexpected status 404 Not Found: The model `gpt-x` does not exist",
      true,
      expect.stringMatching(/^⚠️ This model was not found/),
    ],
    [forbidden, true, forbidden],
    [unauthorized, false, unauthorized],
  ] as const)("renders provider copy in context: %s", (raw, errorContext, expected) => {
    expect(sanitizedCopy(raw, errorContext ? { errorContext } : undefined)).toEqual(expected);
  });
  const aggregate =
    "All models failed (3): anthropic/claude-opus-5: You've hit your session limit · resets 6:20pm (Europe/London) (unknown) | " +
    "claude-cli/claude-sonnet-5: You've hit your session limit · resets 6:20pm (Europe/London) (unknown) | " +
    "openai/gpt-5.6-sol: Codex error: The usage limit has been reached (rate_limit)";

  it("keeps reset hints beyond the summary length guard", () => {
    expect(aggregate.length).toBeGreaterThan(300);
    const copy = renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: aggregate });
    expect(copy).toContain("resets 6:20pm (Europe/London)");
  });
});
