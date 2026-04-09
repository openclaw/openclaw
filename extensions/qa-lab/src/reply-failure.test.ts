import { describe, expect, it } from "vitest";
import { extractQaFailureReplyText } from "./reply-failure.js";

describe("extractQaFailureReplyText", () => {
  it("returns undefined for normal assistant replies", () => {
    expect(
      extractQaFailureReplyText("Yes, precious. The build is green and a little cursed."),
    ).toBe(undefined);
  });

  it("classifies the generic external fallback reply as a failure", () => {
    expect(
      extractQaFailureReplyText(
        "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      ),
    ).toContain("Something went wrong while processing your request.");
  });

  it("classifies explicit provider auth guidance as a failure", () => {
    expect(
      extractQaFailureReplyText(
        '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      ),
    ).toContain('No API key found for provider "openai".');
  });

  it("classifies curated missing-key guidance as a failure", () => {
    expect(
      extractQaFailureReplyText(
        "⚠️ Missing API key for OpenAI on the gateway. Use `openai-codex/gpt-5.4` for OAuth, or set `OPENAI_API_KEY`, then try again.",
      ),
    ).toContain("Missing API key for OpenAI on the gateway.");
  });
});
