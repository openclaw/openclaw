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
    expect(stripModelSpecialTokens("<channel|>Visible answer")).toBe("<channel|>Visible answer");
    expect(stripModelSpecialTokens("<channel|>\nVisible answer")).toBe(
      "<channel|>\nVisible answer",
    );
    expect(stripModelSpecialTokens("internal planning <channel|> Visible answer")).toBe(
      " Visible answer",
    );
    expect(stripModelSpecialTokens("The marker <channel|> splits streams.")).toBe(
      "The marker <channel|> splits streams.",
    );
    expect(stripModelSpecialTokens("Before <channel|> after")).toBe("Before <channel|> after");
    expect(stripModelSpecialTokens("<channel|> token marks the visible channel.")).toBe(
      "<channel|> token marks the visible channel.",
    );
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

  it("strips spaced leaked channel delimiters after a long internal-answer preamble", () => {
    const input = [
      "The user is instructing me to reply with a very specific string and nothing else.",
      "This is a direct instruction for the output content.",
      "I must output the text directly as the final response.",
      "<channel|> Visible answer",
    ].join("\n");

    expect(stripModelSpecialTokens(input)).toBe(" Visible answer");
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

  it("preserves a literal trailing channel delimiter inside recovered visible text", () => {
    expect(stripModelSpecialTokens("internal planning<channel|>Use token <channel|>")).toBe(
      "Use token <channel|>",
    );
  });

  it("preserves an explicitly requested literal channel delimiter target", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `<channel|>` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|><channel|>",
    ].join("\n");

    expect(stripModelSpecialTokens(input)).toBe("<channel|>");
  });

  it("preserves an explicitly requested literal channel delimiter target when it is named in quotes", () => {
    const input = [
      'The user is instructing me to reply with a very specific string: "<channel|>" and nothing else.',
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|><channel|>",
    ].join("\n");

    expect(stripModelSpecialTokens(input)).toBe("<channel|>");
  });

  it("preserves an explicitly requested visible string that ends with a channel delimiter", () => {
    const input = [
      'The user is instructing me to reply with exactly "Print <channel|>" and nothing else.',
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|>Print <channel|>",
    ].join("\n");

    expect(stripModelSpecialTokens(input)).toBe("Print <channel|>");
  });

  it("treats plan-prefixed channel delimiters as leaked scaffolding", () => {
    expect(stripModelSpecialTokens("plan: <channel|>Visible answer")).toBe("Visible answer");
    expect(stripModelSpecialTokens("planning notes\nplan: <channel|>Visible answer")).toBe(
      "Visible answer",
    );
  });

  it("does not treat ordinary prose with 'plan:' as leaked scaffolding", () => {
    expect(stripModelSpecialTokens("My plan: <channel|> is the separator token.")).toBe(
      "My plan: <channel|> is the separator token.",
    );
    expect(
      stripModelSpecialTokens(
        "Here is the explanation.\nMy plan: <channel|> is the separator token, not hidden scaffolding.",
      ),
    ).toBe(
      "Here is the explanation.\nMy plan: <channel|> is the separator token, not hidden scaffolding.",
    );
  });

  it("preserves earlier visible text when a leaked delimiter trails it", () => {
    expect(stripModelSpecialTokens("Visible answer\nplan: <channel|>")).toBe("Visible answer");
  });
});
