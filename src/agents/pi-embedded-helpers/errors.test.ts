import { describe, expect, it } from "vitest";
import { isContextOverflowError, isLikelyContextOverflowError } from "./errors.js";

describe("isContextOverflowError — llama.cpp patterns (#30056)", () => {
  it("detects n_keep >= n_ctx error from llama.cpp", () => {
    expect(
      isContextOverflowError("cannot truncate prompt with n_keep (13575) >= n_ctx (4096)"),
    ).toBe(true);
  });

  it("detects bare 'cannot truncate prompt' message", () => {
    expect(isContextOverflowError("cannot truncate prompt")).toBe(true);
  });

  it("detects n_keep >= n_ctx without parentheses", () => {
    expect(isContextOverflowError("error: n_keep 13575 >= n_ctx 4096")).toBe(true);
  });
});

describe("isLikelyContextOverflowError — llama.cpp patterns (#30056)", () => {
  it("classifies n_keep >= n_ctx as context overflow", () => {
    expect(
      isLikelyContextOverflowError("cannot truncate prompt with n_keep (13575) >= n_ctx (4096)"),
    ).toBe(true);
  });

  it("does not classify rate limit errors as context overflow", () => {
    expect(isLikelyContextOverflowError("rate limit exceeded, too many requests")).toBe(false);
  });

  it("does not false-positive on unrelated errors", () => {
    expect(isLikelyContextOverflowError("connection timeout")).toBe(false);
  });
});
