import { describe, expect, it } from "vitest";
import { stripLeakedCjkChars } from "./strip-cjk-leakage.js";

describe("stripLeakedCjkChars", () => {
  it("returns empty/falsy values unchanged", () => {
    expect(stripLeakedCjkChars("")).toBe("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(stripLeakedCjkChars(null as any)).toBe(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(stripLeakedCjkChars(undefined as any)).toBe(undefined);
  });

  it("returns text unchanged when no CJK characters present", () => {
    const text = "Das ist ein ganz normaler deutscher Satz.";
    expect(stripLeakedCjkChars(text)).toBe(text);
  });

  it("strips leaked CJK ideographs from German text", () => {
    // Real example from MiniMax M2.7: "下次" (next time) injected into German
    const input = "Das ist ein Fehler — 下次 werde ich das sauberer durchziehen.";
    const expected = "Das ist ein Fehler — werde ich das sauberer durchziehen.";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });

  it("strips CJK from bold markdown context", () => {
    const input = "Was ich下次 anders machen werde:";
    const expected = "Was ich anders machen werde:";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });

  it("strips multiple CJK character occurrences", () => {
    const input = "Erst 检查 Marketing komplett fertig, dann 提交 Tech übergeben";
    const expected = "Erst Marketing komplett fertig, dann Tech übergeben";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });

  it("strips single leaked CJK character", () => {
    const input = "Hello 世 world";
    const expected = "Hello world";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });

  it("replaces CJK punctuation with Latin equivalents", () => {
    const input = "Das ist ein Test。Und noch einer，oder？";
    const expected = "Das ist ein Test.Und noch einer,oder?";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });

  it("preserves intentional CJK text (Chinese)", () => {
    const text = "这是一个完全用中文写的句子，不应该被修改。";
    expect(stripLeakedCjkChars(text)).toBe(text);
  });

  it("preserves intentional CJK text (mixed Chinese with some English)", () => {
    const text = "这是一个test句子，包含一些English words但主要是中文。";
    expect(stripLeakedCjkChars(text)).toBe(text);
  });

  it("preserves Japanese text with Kanji", () => {
    const text = "東京は日本の首都です。とても大きな都市です。";
    expect(stripLeakedCjkChars(text)).toBe(text);
  });

  it("preserves Korean text with Hanja (if significant)", () => {
    // Korean sometimes uses Hanja (Chinese characters) intentionally
    const text = "大韓民國은 아시아에 있습니다.";
    // This has a mix — the CJK fraction should be evaluated
    expect(stripLeakedCjkChars(text)).toBe(text);
  });

  it("strips from English text", () => {
    const input = "I will do better 下次 time.";
    const expected = "I will do better time.";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });

  it("preserves text that is purely CJK (100% CJK fraction)", () => {
    // Edge case: just spaces and a CJK char — CJK fraction is 100%, so it's kept
    const input = "   下   ";
    expect(stripLeakedCjkChars(input)).toBe("   下   ");
  });

  it("collapses double spaces after stripping", () => {
    const input = "word 下次 word";
    // After stripping "下次": "word  word" → "word word"
    expect(stripLeakedCjkChars(input)).toBe("word word");
  });

  it("handles CJK at the very start of text", () => {
    const input = "下次Let me check that.";
    const expected = "Let me check that.";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });

  it("handles CJK at the very end of text", () => {
    const input = "Let me check that.下次";
    const expected = "Let me check that.";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });

  it("handles emoji correctly (does not strip emoji)", () => {
    const input = "Great job! 🎉 Keep going 下次 like this!";
    const expected = "Great job! 🎉 Keep going like this!";
    expect(stripLeakedCjkChars(input)).toBe(expected);
  });
});
