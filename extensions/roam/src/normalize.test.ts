import { describe, expect, it } from "vitest";
import {
  looksLikeRoamTargetId,
  normalizeRoamMessagingTarget,
  stripRoamTargetPrefix,
} from "./normalize.js";

describe("stripRoamTargetPrefix", () => {
  it("strips roam: prefix", () => {
    expect(stripRoamTargetPrefix("roam:abc-123")).toBe("abc-123");
  });

  it("strips roam-hq: prefix", () => {
    expect(stripRoamTargetPrefix("roam-hq:abc")).toBe("abc");
  });

  it("strips roam:group: compound prefix", () => {
    expect(stripRoamTargetPrefix("roam:group:abc")).toBe("abc");
  });

  it("strips roam:dm: compound prefix", () => {
    expect(stripRoamTargetPrefix("roam:dm:abc")).toBe("abc");
  });

  it("strips roam:user: compound prefix", () => {
    expect(stripRoamTargetPrefix("roam:user:abc")).toBe("abc");
  });

  it("returns undefined for empty string", () => {
    expect(stripRoamTargetPrefix("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only", () => {
    expect(stripRoamTargetPrefix("   ")).toBeUndefined();
  });

  it("returns undefined for prefix-only input", () => {
    expect(stripRoamTargetPrefix("roam:")).toBeUndefined();
  });

  it("passes through bare UUID", () => {
    const uuid = "01234567-abcd-4000-8000-000000000000";
    expect(stripRoamTargetPrefix(uuid)).toBe(uuid);
  });

  it("trims whitespace", () => {
    expect(stripRoamTargetPrefix("  roam:abc  ")).toBe("abc");
  });
});

describe("normalizeRoamMessagingTarget", () => {
  it("normalizes to canonical roam: format", () => {
    expect(normalizeRoamMessagingTarget("roam:group:abc")).toBe("roam:abc");
  });

  it("returns undefined for empty input", () => {
    expect(normalizeRoamMessagingTarget("")).toBeUndefined();
  });

  it("wraps bare ID with roam: prefix", () => {
    expect(normalizeRoamMessagingTarget("abc-123")).toBe("roam:abc-123");
  });
});

describe("looksLikeRoamTargetId", () => {
  it("detects roam: prefix", () => {
    expect(looksLikeRoamTargetId("roam:abc")).toBe(true);
  });

  it("detects roam-hq: prefix", () => {
    expect(looksLikeRoamTargetId("roam-hq:abc")).toBe(true);
  });

  it("detects bare UUID", () => {
    expect(looksLikeRoamTargetId("01234567-abcd-4000-8000-000000000000")).toBe(true);
  });

  it("rejects random string", () => {
    expect(looksLikeRoamTargetId("hello")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(looksLikeRoamTargetId("")).toBe(false);
  });

  it("rejects partial UUID", () => {
    expect(looksLikeRoamTargetId("01234567")).toBe(false);
  });
});
