import { describe, expect, it } from "vitest";
import { stripModelSpecialTokens } from "./pi-embedded-utils.js";

/**
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
describe("stripModelSpecialTokens", () => {
  it("strips tokens and inserts space between adjacent words", () => {
    expect(stripModelSpecialTokens("<|user|>Question<|assistant|>Answer")).toBe("Question Answer");
  });

  it("strips full-width pipe variants (DeepSeek U+FF5C)", () => {
    expect(stripModelSpecialTokens("<｜begin▁of▁sentence｜>Hello there")).toBe("Hello there");
  });

  it("does not strip normal angle brackets or HTML", () => {
    expect(stripModelSpecialTokens("a < b && c > d")).toBe("a < b && c > d");
    expect(stripModelSpecialTokens("<div>hello</div>")).toBe("<div>hello</div>");
  });

  it("passes through text without tokens unchanged", () => {
    const text = "Just a normal response.";
    expect(stripModelSpecialTokens(text)).toBe(text);
  });

  it("preserves literal channel delimiter mentions when they are part of ordinary prose", () => {
    expect(stripModelSpecialTokens("The marker <channel|> splits streams.")).toBe(
      "The marker <channel|> splits streams.",
    );
    expect(stripModelSpecialTokens("Before <channel|> after")).toBe("Before <channel|> after");
    expect(stripModelSpecialTokens("Tell it to reply with <channel|> to split streams")).toBe(
      "Tell it to reply with <channel|> to split streams",
    );
  });

  it("keeps the last non-empty visible segment when multiple leaked channel delimiters appear", () => {
    expect(stripModelSpecialTokens("internal planning<channel|>Visible answer<channel|>")).toBe(
      "Visible answer",
    );
  });
});
