// Regression tests for #103385: locale-aware tab reuse
// Google Meet DOM scripts match English UI labels; non-English tabs must be skipped.
import { describe, expect, it } from "vitest";
import { isEnglishMeetTab } from "./chrome-browser-proxy.js";

describe("isEnglishMeetTab (regression #103385)", () => {
  it("skips localized meet tab when reusing for join", () => {
    // BEFORE: tab with hl=ja was reused, DOM matchers went blind
    // AFTER: skip non-English tabs
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?hl=ja")).toBe(false);
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?hl=zh-TW")).toBe(false);
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?hl=es")).toBe(false);
  });

  it("accepts english meet tabs with hl=en", () => {
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?hl=en")).toBe(true);
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?authuser=1&hl=en")).toBe(true);
  });

  it("rejects meet tabs without hl parameter (ambiguous locale)", () => {
    // ClawSweeper P1: No hl parameter is ambiguous - could be localized by account
    // Only explicit hl=en is safe for reuse
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij")).toBe(false);
    expect(isEnglishMeetTab("https://meet.google.com/new")).toBe(false);
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?authuser=2")).toBe(false);
  });

  it("rejects non-meet URLs", () => {
    expect(isEnglishMeetTab("https://google.com")).toBe(false);
    expect(isEnglishMeetTab("https://gmail.com")).toBe(false);
    expect(isEnglishMeetTab(undefined)).toBe(false);
    expect(isEnglishMeetTab(null)).toBe(false);
    expect(isEnglishMeetTab("")).toBe(false);
  });
});
