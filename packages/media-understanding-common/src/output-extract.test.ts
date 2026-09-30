import { describe, expect, it } from "vitest";
import { extractGeminiResponse } from "./output-extract.js";

describe("extractGeminiResponse", () => {
  it("extracts the response from noisy output with nested JSON objects", () => {
    const raw =
      'debug: invoking gemini\n{"response":"a useful description","usage":{"inputTokens":12,"outputTokens":4}}';
    expect(extractGeminiResponse(raw)).toBe("a useful description");
  });

  it("ignores unmatched quotes in noisy output before the JSON object", () => {
    expect(extractGeminiResponse('debug: model said "hello\n{"response":"ok"}')).toBe("ok");
  });

  it("ignores braces inside quoted noisy output", () => {
    expect(extractGeminiResponse('debug: "hello { world" {"response":"ok"}')).toBe("ok");
  });

  it("ignores shell-quoted JSON-like noisy output", () => {
    expect(extractGeminiResponse('debug: \'{"response":"fake"}\'')).toBeNull();
  });

  it("does not treat apostrophes inside noisy words as quote delimiters", () => {
    expect(extractGeminiResponse('debug: it\'s done {"response":"ok"}')).toBe("ok");
  });

  it("resynchronizes after an unmatched brace in noisy output", () => {
    expect(extractGeminiResponse('debug: generated {\n{"response":"ok"}')).toBe("ok");
  });

  it("preserves brace-heavy response text", () => {
    const response = "{".repeat(33);
    expect(extractGeminiResponse(JSON.stringify({ response }))).toBe(response);
  });

  it("preserves pretty-printed object elements inside arrays", () => {
    const raw = JSON.stringify(
      { response: "array response", items: [{ id: 1 }, { id: 2 }] },
      null,
      2,
    );
    expect(extractGeminiResponse(raw)).toBe("array response");
  });

  it("does not accept an inner response from a malformed trailing object", () => {
    expect(extractGeminiResponse('{"response":"good"} {"meta":{"response":"bad"} broken}')).toBe(
      "good",
    );
    expect(extractGeminiResponse('{"response":"good"} {"meta":{"response":"bad"}')).toBe("good");
  });

  it("does not promote a child from a malformed outer object", () => {
    expect(extractGeminiResponse('{"response":"good"} {"meta" {"response":"bad"}}')).toBe("good");
    expect(extractGeminiResponse('noise {broken {"response":"bad"}}')).toBeNull();
    expect(extractGeminiResponse('{"response":"good"}\nnoise {broken\n{"response":"bad"}}')).toBe(
      "good",
    );
  });
});
