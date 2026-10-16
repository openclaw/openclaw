/**
 * Regression coverage for model special-token stripping.
 * Ensures provider wrapper tokens do not leak into visible assistant text.
 */
import { describe, expect, it } from "vitest";
import { stripModelSpecialTokens } from "../shared/text/model-special-tokens.js";

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

  it.each([
    ["closing punctuation", "Hello<|assistant|>.", "Hello."],
    ["opening punctuation", "(<|assistant|>Hello", "(Hello"],
    ["astral letters", "𐐀<|assistant|>𐐁", "𐐀 𐐁"],
    ["Unicode digits", "١<|assistant|>٢", "١ ٢"],
    ["left combining mark", "cafe\u0301<|assistant|>word", "cafe\u0301 word"],
    ["right combining mark", "cafe<|assistant|>\u0301word", "cafe\u0301word"],
    ["adjacent tokens", "first<|user|><|assistant|>second", "first second"],
  ])("preserves %s when removing tokens", (_name, input, expected) => {
    expect(stripModelSpecialTokens(input)).toBe(expected);
  });

  it("keeps prose between pipe operators", () => {
    const text = "Elm: use <| for application.\n\nLater: chain with |> instead.";
    expect(stripModelSpecialTokens(text)).toBe(text);
    expect(stripModelSpecialTokens("In F#, <| pipes backward and |> pipes forward.")).toBe(
      "In F#, <| pipes backward and |> pipes forward.",
    );
    expect(stripModelSpecialTokens("a <| b |> c<|im_end|><|endoftext|>")).toBe("a <| b |> c");
  });
});
