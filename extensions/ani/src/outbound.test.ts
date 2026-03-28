import { describe, it, expect } from "vitest";
import { parseConversationId } from "./outbound.js";

describe("parseConversationId", () => {
  it("parses a plain numeric string", () => {
    expect(parseConversationId("123")).toBe(123);
  });

  it("parses ani:conv:123 format", () => {
    expect(parseConversationId("ani:conv:123")).toBe(123);
  });

  it("parses ANI:conv:456 (case-insensitive prefix)", () => {
    expect(parseConversationId("ANI:conv:456")).toBe(456);
  });

  it("parses ani:channel:789 format", () => {
    expect(parseConversationId("ani:channel:789")).toBe(789);
  });

  it("strips whitespace around the number", () => {
    expect(parseConversationId("  42  ")).toBe(42);
  });

  it("throws on empty string", () => {
    expect(() => parseConversationId("")).toThrow("invalid conversation target");
  });

  it("throws on non-numeric string", () => {
    expect(() => parseConversationId("abc")).toThrow("invalid conversation target");
  });

  it("throws on zero", () => {
    expect(() => parseConversationId("0")).toThrow("invalid conversation target");
  });

  it("throws on negative numbers", () => {
    expect(() => parseConversationId("-5")).toThrow("invalid conversation target");
  });

  it("throws on floating point", () => {
    expect(() => parseConversationId("3.14")).toThrow("invalid conversation target");
  });
});
