import { describe, expect, it } from "vitest";
import { installCommonResolveTargetErrorCases } from "../../shared/resolve-target-test-helpers.js";
import {
  normalizeNapCatAllowEntry,
  parseNapCatTarget,
  resolveNapCatTarget,
  isNapCatSenderAllowed,
} from "./targets.js";

describe("parseNapCatTarget", () => {
  it("parses user targets", () => {
    expect(parseNapCatTarget("123456")).toEqual({ kind: "user", id: "123456", to: "user:123456" });
    expect(parseNapCatTarget("user:123456")?.to).toBe("user:123456");
    expect(parseNapCatTarget("qq:user:123456")?.to).toBe("user:123456");
  });

  it("parses group targets", () => {
    expect(parseNapCatTarget("group:987654")?.to).toBe("group:987654");
    expect(parseNapCatTarget("g:987654")?.to).toBe("group:987654");
    expect(parseNapCatTarget("napcat:group:987654")?.to).toBe("group:987654");
  });

  it("rejects unknown targets", () => {
    expect(parseNapCatTarget("abc")).toBeNull();
    expect(parseNapCatTarget("")).toBeNull();
  });
});

describe("allowFrom normalization", () => {
  it("normalizes prefixes and whitespace", () => {
    expect(normalizeNapCatAllowEntry(" qq:user:123 ")).toBe("123");
    expect(normalizeNapCatAllowEntry("group:456")).toBe("456");
    expect(normalizeNapCatAllowEntry("*")).toBe("*");
  });

  it("matches sender against allowFrom", () => {
    expect(isNapCatSenderAllowed(["123"], "qq:user:123")).toBe(true);
    expect(isNapCatSenderAllowed(["*"], "999")).toBe(true);
    expect(isNapCatSenderAllowed(["123"], "999")).toBe(false);
  });
});

describe("resolveNapCatTarget", () => {
  it("resolves explicit targets", () => {
    const user = resolveNapCatTarget({
      to: "user:123",
      mode: "explicit",
      allowFrom: [],
    });
    expect(user.ok).toBe(true);
    if (user.ok) {
      expect(user.to).toBe("user:123");
    }
  });

  it("resolves implicit target from single allowFrom entry", () => {
    const result = resolveNapCatTarget({
      to: undefined,
      mode: "implicit",
      allowFrom: ["user:456"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.to).toBe("user:456");
    }
  });

  installCommonResolveTargetErrorCases({
    resolveTarget: resolveNapCatTarget,
    implicitAllowFrom: ["user:123"],
  });
});
