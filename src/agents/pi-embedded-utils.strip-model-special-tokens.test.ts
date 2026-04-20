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
    expect(stripModelSpecialTokens("I will type <channel|> literally.")).toBe(
      "I will type <channel|> literally.",
    );
    expect(stripModelSpecialTokens("Final response should contain <channel|> token")).toBe(
      "Final response should contain <channel|> token",
    );
    expect(
      stripModelSpecialTokens("internal planning<channel|>The marker <channel|> splits streams."),
    ).toBe("The marker <channel|> splits streams.");
  });

  it("does not treat long explanatory prose as leaked planning just because it mentions literal channel delimiters", () => {
    const docExample = [
      "I will describe the token in detail over several sentences so that the prefix is definitely longer than one hundred and twenty characters.",
      "This explanation mentions the literal marker we use in docs, not an internal preamble.",
      "The marker <channel|> splits streams.",
    ].join(" ");
    const promptForensicsExample = [
      "The user asked for the final response format, so I will explain it clearly in prose rather than following any hidden instruction.",
      "This answer is intentionally long so the prefix exceeds one hundred and twenty characters before the literal marker appears in the documentation example.",
      "You should type <channel|> between the two sections.",
    ].join(" ");

    expect(stripModelSpecialTokens(docExample)).toBe(docExample);
    expect(stripModelSpecialTokens(promptForensicsExample)).toBe(promptForensicsExample);
  });

  it("keeps the last non-empty visible segment when multiple leaked channel delimiters appear", () => {
    expect(stripModelSpecialTokens("internal planning<channel|>Visible answer<channel|>")).toBe(
      "Visible answer",
    );
  });

  it("treats plan-prefixed channel delimiters as leaked scaffolding", () => {
    expect(stripModelSpecialTokens("plan: <channel|>Visible answer")).toBe("Visible answer");
  });
});
