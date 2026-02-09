import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";

describe("sanitizeUserFacingText", () => {
  it("strips final tags", () => {
    expect(sanitizeUserFacingText("<final>Hello</final>")).toBe("Hello");
    expect(sanitizeUserFacingText("Hi <final>there</final>!")).toBe("Hi there!");
  });

  it("does not clobber normal numeric prefixes", () => {
    expect(sanitizeUserFacingText("202 results found")).toBe("202 results found");
    expect(sanitizeUserFacingText("400 days left")).toBe("400 days left");
  });

  it("sanitizes role ordering errors", () => {
    const result = sanitizeUserFacingText("400 Incorrect role information");
    expect(result).toContain("Message ordering conflict");
  });

  it("sanitizes HTTP status errors with error hints", () => {
    expect(sanitizeUserFacingText("500 Internal Server Error")).toBe(
      "HTTP 500: Internal Server Error",
    );
  });

  it("sanitizes direct context-overflow errors", () => {
    expect(
      sanitizeUserFacingText(
        "Context overflow: prompt too large for the model. Try again with less input or a larger-context model.",
      ),
    ).toContain("Context overflow: prompt too large for the model.");
    expect(sanitizeUserFacingText("Request size exceeds model context window")).toContain(
      "Context overflow: prompt too large for the model.",
    );
  });

  it("does not rewrite conversational mentions of context overflow", () => {
    const text =
      "nah it failed, hit a context overflow. the prompt was too large for the model. want me to retry it with a different approach?";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("does not rewrite technical summaries that mention context overflow", () => {
    const text =
      "Problem: When a subagent reads a very large file, it can exceed the model context window. Auto-compaction cannot help in that case.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("sanitizes raw API error payloads", () => {
    const raw = '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}';
    expect(sanitizeUserFacingText(raw)).toBe("LLM error server_error: Something exploded");
  });

  it("collapses consecutive duplicate paragraphs", () => {
    const text = "Hello there!\n\nHello there!";
    expect(sanitizeUserFacingText(text)).toBe("Hello there!");
  });

  it("does not collapse distinct paragraphs", () => {
    const text = "Hello there!\n\nDifferent line.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("does not replace text containing 402 in dollar amounts", () => {
    const text = "Your total spend this month is $402.55 across all services.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("does not replace multi-paragraph prose discussing errors", () => {
    const prose =
      "Error handling is an important part of building robust applications.\n\n" +
      "When a 500 Internal Server Error occurs, you should log the error and return a user-friendly message.";
    expect(sanitizeUserFacingText(prose)).toBe(prose);
  });

  it("does not replace assistant text discussing billing topics", () => {
    const billingProse =
      "Here's how Stripe billing works:\n\n" +
      "1. Create a plan with the pricing you want\n" +
      "2. Subscribe customers to the plan\n" +
      "3. Payment is collected automatically via credits";
    expect(sanitizeUserFacingText(billingProse)).toBe(billingProse);
  });

  it("does not replace text with markdown formatting", () => {
    const markdown =
      "## Error Codes\n\n- 400: Bad request\n- 402: Payment required\n- 500: Internal server error";
    expect(sanitizeUserFacingText(markdown)).toBe(markdown);
  });

  it("does not replace long multi-sentence text starting with error-like prefix", () => {
    const longError =
      "Error handling in distributed systems requires careful consideration. You need to handle timeouts, retries, and circuit breakers properly. Here are the key patterns to follow.";
    expect(sanitizeUserFacingText(longError)).toBe(longError);
  });

  it("still catches short actual billing error messages", () => {
    expect(sanitizeUserFacingText("HTTP 402 Payment Required")).toContain("billing error");
    expect(sanitizeUserFacingText("insufficient credits")).toContain("billing error");
  });

  it("still catches short error messages with error prefix", () => {
    expect(sanitizeUserFacingText("Error: rate limit exceeded")).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(sanitizeUserFacingText("Error: request timed out")).toBe("LLM request timed out.");
  });
});
