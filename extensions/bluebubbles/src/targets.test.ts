import { describe, expect, it } from "vitest";
import { normalizeBlueBubblesHandle } from "./targets.js";

describe("normalizeBlueBubblesHandle", () => {
  it("prefixes all-digit input with +", () => {
    expect(normalizeBlueBubblesHandle("19175551234")).toBe("+19175551234");
  });

  it("leaves already-prefixed E.164 number unchanged", () => {
    expect(normalizeBlueBubblesHandle("+19175551234")).toBe("+19175551234");
  });

  it("leaves email handle unchanged (lowercased)", () => {
    expect(normalizeBlueBubblesHandle("User@Example.com")).toBe("user@example.com");
  });

  it("strips service prefix before normalizing digits", () => {
    expect(normalizeBlueBubblesHandle("iMessage:19175551234")).toBe("+19175551234");
    expect(normalizeBlueBubblesHandle("sms:19175551234")).toBe("+19175551234");
    expect(normalizeBlueBubblesHandle("auto:19175551234")).toBe("+19175551234");
  });

  it("strips spaces from all-digit number and prefixes with +", () => {
    expect(normalizeBlueBubblesHandle("1 917 555 1234")).toBe("+19175551234");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeBlueBubblesHandle("")).toBe("");
    expect(normalizeBlueBubblesHandle("  ")).toBe("");
  });
});
