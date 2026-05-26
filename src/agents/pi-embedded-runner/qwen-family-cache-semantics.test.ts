import { describe, expect, it } from "vitest";
import { isClosedSourceQwenModelRef } from "./qwen-family-cache-semantics.js";

describe("isClosedSourceQwenModelRef", () => {
  it("matches versioned commercial-tier qwen models", () => {
    for (const id of [
      "qwen/qwen3-max",
      "qwen/qwen3-plus",
      "qwen/qwen3-flash",
      "qwen/qwen3.5-max",
      "qwen/qwen3.5.1-max",
      "qwen/qwen4-max",
    ]) {
      expect(isClosedSourceQwenModelRef(id)).toBe(true);
    }
  });

  it("matches dated and preview snapshots", () => {
    for (const id of [
      "qwen/qwen3-max-2025-09-23",
      "qwen/qwen3-max-2507",
      "qwen/qwen3-plus-2025-01-25",
      "qwen/qwen3.6-max-preview",
    ]) {
      expect(isClosedSourceQwenModelRef(id)).toBe(true);
    }
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(isClosedSourceQwenModelRef("Qwen/Qwen3-Max")).toBe(true);
    expect(isClosedSourceQwenModelRef(" qwen/qwen3-max ")).toBe(true);
  });

  it("rejects open-source qwen models", () => {
    for (const id of [
      "qwen/qwen3-235b-a22b",
      "qwen/qwen3-235b-a22b-instruct-2507",
      "qwen/qwen3-coder",
      "qwen/qwen3-32b",
      "qwen/qwq-32b",
      "qwen/qwen-2.5-72b-instruct",
    ]) {
      expect(isClosedSourceQwenModelRef(id)).toBe(false);
    }
  });

  it("rejects qwen models with middle qualifiers", () => {
    for (const id of ["qwen/qwen3-coder-plus", "qwen/qwen3-coder-flash", "qwen/qwen3-vl-max"]) {
      expect(isClosedSourceQwenModelRef(id)).toBe(false);
    }
  });

  it("rejects unversioned rolling aliases", () => {
    for (const id of ["qwen/qwen-max", "qwen/qwen-plus", "qwen/qwen-turbo", "qwen/qwen-flash"]) {
      expect(isClosedSourceQwenModelRef(id)).toBe(false);
    }
  });

  it("rejects turbo tier", () => {
    for (const id of ["qwen/qwen3-turbo", "qwen/qwen3-turbo-2025-01-25"]) {
      expect(isClosedSourceQwenModelRef(id)).toBe(false);
    }
  });
});
