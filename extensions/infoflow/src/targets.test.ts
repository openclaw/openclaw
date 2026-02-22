import { describe, expect, it, vi } from "vitest";

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: { shouldLogVerbose: () => false },
  })),
}));

import { normalizeInfoflowTarget, looksLikeInfoflowId } from "./targets.js";

// ============================================================================
// normalizeInfoflowTarget
// ============================================================================

describe("normalizeInfoflowTarget", () => {
  it("strips infoflow: prefix", () => {
    expect(normalizeInfoflowTarget("infoflow:chengbo05")).toBe("chengbo05");
  });

  it("strips user: prefix", () => {
    expect(normalizeInfoflowTarget("user:chengbo05")).toBe("chengbo05");
  });

  it("keeps group: prefix", () => {
    expect(normalizeInfoflowTarget("group:123456")).toBe("group:123456");
  });

  it("converts pure digits to group:", () => {
    expect(normalizeInfoflowTarget("123456")).toBe("group:123456");
  });

  it("returns undefined for empty string", () => {
    expect(normalizeInfoflowTarget("")).toBeUndefined();
  });
});

// ============================================================================
// looksLikeInfoflowId
// ============================================================================

describe("looksLikeInfoflowId", () => {
  it("accepts group: prefix", () => {
    expect(looksLikeInfoflowId("group:123")).toBe(true);
  });

  it("accepts pure digits", () => {
    expect(looksLikeInfoflowId("12345")).toBe(true);
  });

  it("accepts alphanumeric starting with letter", () => {
    expect(looksLikeInfoflowId("chengbo05")).toBe(true);
  });

  it("rejects special characters", () => {
    expect(looksLikeInfoflowId("user@domain.com")).toBe(false);
  });
});
