import { describe, expect, it } from "vitest";
import {
  looksLikeTwilioSmsTargetId,
  normalizeTwilioSmsAllowEntry,
  normalizeTwilioSmsTarget,
} from "./targets.js";

describe("normalizeTwilioSmsTarget", () => {
  it("passes through valid E.164 numbers", () => {
    expect(normalizeTwilioSmsTarget("+15551234567")).toBe("+15551234567");
  });

  it("adds + prefix to bare digits", () => {
    expect(normalizeTwilioSmsTarget("15551234567")).toBe("+15551234567");
  });

  it("strips non-digit characters", () => {
    expect(normalizeTwilioSmsTarget("+1 (555) 123-4567")).toBe("+15551234567");
  });
});

describe("looksLikeTwilioSmsTargetId", () => {
  it("accepts E.164 numbers", () => {
    expect(looksLikeTwilioSmsTargetId("+15551234567")).toBe(true);
    expect(looksLikeTwilioSmsTargetId("+447911123456")).toBe(true);
  });

  it("accepts bare digits starting with country code", () => {
    expect(looksLikeTwilioSmsTargetId("15551234567")).toBe(true);
  });

  it("rejects empty or text strings", () => {
    expect(looksLikeTwilioSmsTargetId("")).toBe(false);
    expect(looksLikeTwilioSmsTargetId("not a number")).toBe(false);
    expect(looksLikeTwilioSmsTargetId("abc123")).toBe(false);
  });

  it("rejects numbers starting with 0", () => {
    expect(looksLikeTwilioSmsTargetId("05551234567")).toBe(false);
  });

  it("handles whitespace", () => {
    expect(looksLikeTwilioSmsTargetId("  +15551234567  ")).toBe(true);
  });
});

describe("normalizeTwilioSmsAllowEntry", () => {
  it("normalizes plain E.164 numbers", () => {
    expect(normalizeTwilioSmsAllowEntry("+15551234567")).toBe("+15551234567");
  });

  it("strips twilio-sms: prefix", () => {
    expect(normalizeTwilioSmsAllowEntry("twilio-sms:+15551234567")).toBe("+15551234567");
  });

  it("strips prefix case-insensitively", () => {
    expect(normalizeTwilioSmsAllowEntry("Twilio-SMS:+15551234567")).toBe("+15551234567");
  });

  it("normalizes after stripping prefix", () => {
    expect(normalizeTwilioSmsAllowEntry("twilio-sms:15551234567")).toBe("+15551234567");
  });
});
