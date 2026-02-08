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

  it("sanitizes role ordering errors with errorContext", () => {
    const result = sanitizeUserFacingText("400 Incorrect role information", { errorContext: true });
    expect(result).toContain("Message ordering conflict");
  });

  it("does not rewrite role ordering text without errorContext", () => {
    const text = "400 Incorrect role information";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("sanitizes HTTP status errors with errorContext", () => {
    expect(sanitizeUserFacingText("500 Internal Server Error", { errorContext: true })).toBe(
      "HTTP 500: Internal Server Error",
    );
  });

  it("does not rewrite HTTP status text without errorContext", () => {
    expect(sanitizeUserFacingText("500 Internal Server Error")).toBe("500 Internal Server Error");
  });

  it("sanitizes direct context-overflow errors with errorContext", () => {
    expect(
      sanitizeUserFacingText(
        "Context overflow: prompt too large for the model. Try again with less input or a larger-context model.",
        { errorContext: true },
      ),
    ).toContain("Context overflow: prompt too large for the model.");
    expect(
      sanitizeUserFacingText("Request size exceeds model context window", { errorContext: true }),
    ).toContain("Context overflow: prompt too large for the model.");
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

  it("sanitizes raw API error payloads with errorContext", () => {
    const raw = '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}';
    expect(sanitizeUserFacingText(raw, { errorContext: true })).toBe(
      "LLM error server_error: Something exploded",
    );
  });

  it("does not rewrite API error payloads without errorContext", () => {
    const raw = '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}';
    expect(sanitizeUserFacingText(raw)).toBe(raw);
  });

  it("does not replace normal assistant replies discussing billing topics", () => {
    const text =
      "Sure, I can help you understand your billing situation. Your API credits are managed through the billing dashboard. " +
      "To check your current balance, go to Settings > Billing > Credits. If you need to upgrade your plan, " +
      "you can do so from the same page. The payment method on file will be charged automatically.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("rewrites billing error text with errorContext", () => {
    expect(sanitizeUserFacingText("insufficient credits", { errorContext: true })).toContain(
      "billing error",
    );
  });

  it("collapses consecutive duplicate paragraphs", () => {
    const text = "Hello there!\n\nHello there!";
    expect(sanitizeUserFacingText(text)).toBe("Hello there!");
  });

  it("does not collapse distinct paragraphs", () => {
    const text = "Hello there!\n\nDifferent line.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });
});
