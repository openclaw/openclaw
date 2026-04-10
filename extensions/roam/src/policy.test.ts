import { describe, expect, it } from "vitest";
import { normalizeRoamAllowlist, resolveRoamAllowlistMatch } from "./policy.js";

describe("normalizeRoamAllowlist", () => {
  it("strips roam: prefix", () => {
    expect(normalizeRoamAllowlist(["roam:abc"])).toEqual(["abc"]);
  });

  it("strips tag prefix from tagged UUIDs", () => {
    expect(normalizeRoamAllowlist(["U-01234567-abcd-4000-8000-000000000000"])).toEqual([
      "01234567-abcd-4000-8000-000000000000",
    ]);
  });

  it("strips both roam: and tag prefix", () => {
    expect(normalizeRoamAllowlist(["roam:U-abc-123"])).toEqual(["abc-123"]);
  });

  it("lowercases entries", () => {
    expect(normalizeRoamAllowlist(["ABC"])).toEqual(["abc"]);
  });

  it("handles empty input", () => {
    expect(normalizeRoamAllowlist(undefined)).toEqual([]);
  });
});

describe("resolveRoamAllowlistMatch", () => {
  it("matches bare UUID sender against tagged UUID in allowFrom", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["U-01234567-abcd-4000-8000-000000000000"],
      senderId: "01234567-abcd-4000-8000-000000000000",
    });
    expect(result.allowed).toBe(true);
  });

  it("matches tagged UUID sender against bare UUID in allowFrom", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["01234567-abcd-4000-8000-000000000000"],
      senderId: "U-01234567-abcd-4000-8000-000000000000",
    });
    expect(result.allowed).toBe(true);
  });

  it("matches tagged UUID sender against tagged UUID in allowFrom", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["U-abc-123"],
      senderId: "U-abc-123",
    });
    expect(result.allowed).toBe(true);
  });

  it("matches wildcard", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["*"],
      senderId: "anything",
    });
    expect(result.allowed).toBe(true);
    expect(result.matchSource).toBe("wildcard");
  });

  it("rejects unmatched sender", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["U-allowed-user"],
      senderId: "different-user",
    });
    expect(result.allowed).toBe(false);
  });

  it("returns not-allowed for empty allowFrom", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: [],
      senderId: "any",
    });
    expect(result.allowed).toBe(false);
  });
});
