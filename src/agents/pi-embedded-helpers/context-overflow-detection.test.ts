import { describe, expect, it } from "vitest";
import {
  isContextOverflowError,
  isDefiniteContextOverflowError,
  isLikelyContextOverflowError,
} from "./errors.js";

describe("isContextOverflowError — provider-specific patterns", () => {
  describe("AWS Bedrock", () => {
    it("detects ValidationException with input too long", () => {
      expect(isContextOverflowError("ValidationException: The input is too long")).toBe(true);
    });

    it("detects ValidationException with max input token", () => {
      expect(
        isContextOverflowError(
          "ValidationException: Input exceeds the max input token limit of 128000",
        ),
      ).toBe(true);
    });

    it("detects ModelStreamErrorException with input is too long", () => {
      expect(
        isContextOverflowError("ModelStreamErrorException: Input is too long for this model"),
      ).toBe(true);
    });

    it("detects ModelStreamErrorException with too many input tokens", () => {
      expect(isContextOverflowError("ModelStreamErrorException: too many input tokens")).toBe(true);
    });

    it("detects maximum number of input tokens", () => {
      expect(
        isContextOverflowError("Exceeded the maximum number of input tokens for the model"),
      ).toBe(true);
    });
  });

  describe("Ollama / local models", () => {
    it("detects ollama context length error", () => {
      expect(isContextOverflowError("ollama: context length exceeded for llama3")).toBe(true);
    });
  });

  describe("Cohere", () => {
    it("detects total tokens exceeds model max", () => {
      expect(isContextOverflowError("total tokens exceeds the model's max of 4096")).toBe(true);
    });

    it("detects total tokens exceeds limit", () => {
      expect(isContextOverflowError("total tokens exceeds the limit of 4096")).toBe(true);
    });
  });

  describe("generic patterns", () => {
    it("detects input is too long for model", () => {
      expect(isContextOverflowError("input is too long for model gpt-5.4")).toBe(true);
    });

    it("detects input too long for this model", () => {
      expect(isContextOverflowError("input too long for this model")).toBe(true);
    });
  });

  describe("existing patterns still work", () => {
    it("detects context length exceeded", () => {
      expect(isContextOverflowError("context length exceeded")).toBe(true);
    });

    it("detects prompt is too long", () => {
      expect(isContextOverflowError("prompt is too long: 150000 tokens > 128000 maximum")).toBe(
        true,
      );
    });

    it("detects context_window_exceeded", () => {
      expect(isContextOverflowError("context_window_exceeded")).toBe(true);
    });
  });

  describe("false positives", () => {
    it("does not match rate limit with TPM hint", () => {
      expect(isContextOverflowError("413 TPM rate limit exceeded")).toBe(false);
    });

    it("does not match generic rate limit", () => {
      expect(isContextOverflowError("rate limit exceeded")).toBe(false);
    });
  });
});

describe("isLikelyContextOverflowError — provider-specific patterns", () => {
  it("detects Bedrock ValidationException via isContextOverflowError path", () => {
    expect(isLikelyContextOverflowError("ValidationException: The input is too long")).toBe(true);
  });

  it("detects Cohere total tokens via isContextOverflowError path", () => {
    expect(isLikelyContextOverflowError("total tokens exceeds the model's max of 4096")).toBe(true);
  });
});

describe("isDefiniteContextOverflowError", () => {
  it("matches 400 + context length exceeded", () => {
    expect(isDefiniteContextOverflowError("400 context length exceeded")).toBe(true);
  });

  it("matches 400 + prompt is too long", () => {
    expect(isDefiniteContextOverflowError("400 prompt is too long")).toBe(true);
  });

  it("matches 400 + request_too_large", () => {
    expect(isDefiniteContextOverflowError("400 request_too_large")).toBe(true);
  });

  it("does not match without 400 status", () => {
    expect(isDefiniteContextOverflowError("context length exceeded")).toBe(false);
  });

  it("does not match 429 + context overflow", () => {
    expect(isDefiniteContextOverflowError("429 context length exceeded")).toBe(false);
  });

  it("returns false for empty/undefined", () => {
    expect(isDefiniteContextOverflowError(undefined)).toBe(false);
    expect(isDefiniteContextOverflowError("")).toBe(false);
  });
});
