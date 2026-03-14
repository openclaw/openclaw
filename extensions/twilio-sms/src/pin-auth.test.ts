import { afterEach, describe, expect, it } from "vitest";
import { _resetPinAuthSessions, checkPinAuth } from "./pin-auth.js";

describe("checkPinAuth", () => {
  afterEach(() => {
    _resetPinAuthSessions();
  });

  const sender = "+15559876543";
  const pin = "1234";

  it("rejects when no PIN provided in message", () => {
    const result = checkPinAuth({ senderE164: sender, body: "hello", pin, nowMs: 1000 });
    expect(result).toEqual({ ok: false, reason: "pin_required" });
  });

  it("accepts when PIN is the entire message body", () => {
    const result = checkPinAuth({ senderE164: sender, body: "1234", pin, nowMs: 1000 });
    expect(result).toEqual({ ok: true, strippedBody: "" });
  });

  it("accepts when PIN is a prefix and strips it", () => {
    const result = checkPinAuth({
      senderE164: sender,
      body: "1234 check my calories",
      pin,
      nowMs: 1000,
    });
    expect(result).toEqual({ ok: true, strippedBody: "check my calories" });
  });

  it("does not match PIN embedded in text without space separator", () => {
    const result = checkPinAuth({
      senderE164: sender,
      body: "1234Main Street",
      pin,
      nowMs: 1000,
    });
    expect(result).toEqual({ ok: false, reason: "pin_required" });
  });

  it("remembers auth for 24 hours", () => {
    const baseTime = 1_000_000;
    // Authenticate
    checkPinAuth({ senderE164: sender, body: "1234", pin, nowMs: baseTime });

    // Should pass without PIN within 24h
    const result = checkPinAuth({
      senderE164: sender,
      body: "hello",
      pin,
      nowMs: baseTime + 23 * 60 * 60 * 1000,
    });
    expect(result).toEqual({ ok: true, strippedBody: "hello" });
  });

  it("requires re-auth after 24 hours", () => {
    const baseTime = 1_000_000;
    checkPinAuth({ senderE164: sender, body: "1234", pin, nowMs: baseTime });

    const result = checkPinAuth({
      senderE164: sender,
      body: "hello",
      pin,
      nowMs: baseTime + 25 * 60 * 60 * 1000,
    });
    expect(result).toEqual({ ok: false, reason: "pin_required" });
  });

  it("handles whitespace in body", () => {
    const result = checkPinAuth({ senderE164: sender, body: "  1234  ", pin, nowMs: 1000 });
    expect(result).toEqual({ ok: true, strippedBody: "" });
  });

  it("isolates sessions per sender", () => {
    const sender2 = "+15551111111";
    checkPinAuth({ senderE164: sender, body: "1234", pin, nowMs: 1000 });

    const result = checkPinAuth({ senderE164: sender2, body: "hello", pin, nowMs: 1000 });
    expect(result).toEqual({ ok: false, reason: "pin_required" });
  });
});
