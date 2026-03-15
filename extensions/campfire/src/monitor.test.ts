import { describe, expect, it } from "vitest";
import { isSenderAllowed, resolveGroupConfig } from "./monitor.js";

describe("isSenderAllowed", () => {
  it("returns true when allowFrom contains '*'", () => {
    expect(isSenderAllowed(42, "Alice", ["*"])).toBe(true);
  });

  it("matches by numeric user ID", () => {
    expect(isSenderAllowed(42, "Alice", [42])).toBe(true);
  });

  it("matches by string user ID against numeric sender ID", () => {
    expect(isSenderAllowed(42, "Alice", ["42"])).toBe(true);
  });

  it("matches by user name (case-insensitive)", () => {
    expect(isSenderAllowed(42, "Alice", ["alice"])).toBe(true);
    expect(isSenderAllowed(42, "Alice", ["ALICE"])).toBe(true);
  });

  it("matches with 'campfire:' prefix in allowFrom entry", () => {
    expect(isSenderAllowed(42, "Alice", ["campfire:42"])).toBe(true);
    expect(isSenderAllowed(42, "Alice", ["CAMPFIRE:42"])).toBe(true);
  });

  it("returns false for non-matching sender", () => {
    expect(isSenderAllowed(42, "Alice", [99, "bob"])).toBe(false);
  });

  it("ignores empty/whitespace entries", () => {
    expect(isSenderAllowed(42, "Alice", ["", "  ", "bob"])).toBe(false);
  });

  it("returns false for empty allowFrom array", () => {
    expect(isSenderAllowed(42, "Alice", [])).toBe(false);
  });
});

describe("resolveGroupConfig", () => {
  it("returns allowlistConfigured: false for empty groups", () => {
    const result = resolveGroupConfig({ groupId: 1, groups: {} });
    expect(result).toEqual({ entry: undefined, allowlistConfigured: false });
  });

  it("returns allowlistConfigured: false when groups is undefined", () => {
    const result = resolveGroupConfig({ groupId: 1, groups: undefined });
    expect(result).toEqual({ entry: undefined, allowlistConfigured: false });
  });

  it("matches by numeric room ID (as string key)", () => {
    const groups = { "100": { requireMention: false } };
    const result = resolveGroupConfig({ groupId: 100, groups });
    expect(result.entry).toEqual({ requireMention: false });
    expect(result.allowlistConfigured).toBe(true);
  });

  it("matches by exact room name", () => {
    const groups = { "My Room": { requireMention: true } };
    const result = resolveGroupConfig({ groupId: 100, groupName: "My Room", groups });
    expect(result.entry).toEqual({ requireMention: true });
    expect(result.allowlistConfigured).toBe(true);
  });

  it("matches by case-insensitive room name", () => {
    const groups = { "my room": { requireMention: true } };
    const result = resolveGroupConfig({ groupId: 100, groupName: "My Room", groups });
    expect(result.entry).toEqual({ requireMention: true });
    expect(result.allowlistConfigured).toBe(true);
  });

  it("falls back to '*' wildcard entry", () => {
    const groups = { "*": { requireMention: false } };
    const result = resolveGroupConfig({ groupId: 999, groupName: "Unknown", groups });
    expect(result.entry).toEqual({ requireMention: false });
    expect(result.allowlistConfigured).toBe(true);
  });

  it("returns allowlistConfigured: true with undefined entry when no match", () => {
    const groups = { "200": { requireMention: true } };
    const result = resolveGroupConfig({ groupId: 100, groupName: "Other", groups });
    expect(result.entry).toBeUndefined();
    expect(result.allowlistConfigured).toBe(true);
  });

  it("prefers exact ID match over wildcard", () => {
    const groups = {
      "100": { requireMention: false },
      "*": { requireMention: true },
    };
    const result = resolveGroupConfig({ groupId: 100, groups });
    expect(result.entry).toEqual({ requireMention: false });
  });
});
