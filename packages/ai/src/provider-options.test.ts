// Provider option tests cover the tri-state strict reasoning-tag mode mapping.
import { describe, expect, it } from "vitest";
import { reasoningTagTextPolicy, resolveStrictReasoningTagsMode } from "./provider-options.js";

describe("resolveStrictReasoningTagsMode", () => {
  it("resolves the full strict mark to true", () => {
    const options: Record<string, unknown> = {};
    reasoningTagTextPolicy.markStrict(options);

    expect(resolveStrictReasoningTagsMode(options)).toBe(true);
  });

  it("resolves the on-flush strict mark to on-flush", () => {
    const options: Record<string, unknown> = {};
    reasoningTagTextPolicy.markStrictOnFlush(options);

    expect(resolveStrictReasoningTagsMode(options)).toBe("on-flush");
  });

  it("prefers the full strict mark when both marks are present", () => {
    const options: Record<string, unknown> = {};
    reasoningTagTextPolicy.markStrictOnFlush(options);
    reasoningTagTextPolicy.markStrict(options);

    expect(resolveStrictReasoningTagsMode(options)).toBe(true);
  });

  it("resolves unmarked, missing, and null options to false", () => {
    expect(resolveStrictReasoningTagsMode({})).toBe(false);
    expect(resolveStrictReasoningTagsMode(undefined)).toBe(false);
    expect(resolveStrictReasoningTagsMode(null)).toBe(false);
  });
});
