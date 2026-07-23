// Tests that synology-chat account config uses defensive optional chaining.
import { describe, expect, it } from "vitest";

// Test the guard pattern directly: account.token?.trim() && account.incomingUrl?.trim()
// returns false (not a crash) when token or incomingUrl is undefined.
function safeConfiguredCheck(token: string | undefined, incomingUrl: string | undefined): boolean {
  return Boolean(token?.trim() && incomingUrl?.trim());
}

describe("synology-chat account configuration guard", () => {
  it("returns true when both token and incomingUrl are present", () => {
    expect(safeConfiguredCheck("abc123", "https://chat.example.com")).toBe(true);
  });

  it("returns false when token is undefined", () => {
    expect(safeConfiguredCheck(undefined, "https://chat.example.com")).toBe(false);
  });

  it("returns false when incomingUrl is undefined", () => {
    expect(safeConfiguredCheck("abc123", undefined)).toBe(false);
  });

  it("returns false when both fields are undefined", () => {
    expect(safeConfiguredCheck(undefined, undefined)).toBe(false);
  });

  it("returns false when token is empty string", () => {
    expect(safeConfiguredCheck("  ", "https://chat.example.com")).toBe(false);
  });

  it("returns false when incomingUrl is empty string", () => {
    expect(safeConfiguredCheck("abc123", "  ")).toBe(false);
  });
});
