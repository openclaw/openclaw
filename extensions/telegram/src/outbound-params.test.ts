import { describe, expect, it } from "vitest";
import {
  normalizeTelegramReplyToMessageId,
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
} from "./outbound-params.js";

describe("parseTelegramThreadId", () => {
  it("parses numeric and scoped thread ids", () => {
    expect(parseTelegramThreadId("42")).toBe(42);
    expect(parseTelegramThreadId("-10099")).toBe(-10099);
    expect(parseTelegramThreadId("-10099:42")).toBe(42);
    expect(parseTelegramThreadId("-1001234567890:topic:42")).toBe(42);
    expect(parseTelegramThreadId(42)).toBe(42);
  });

  it("returns undefined for invalid thread ids", () => {
    expect(parseTelegramThreadId("abc")).toBeUndefined();
    expect(parseTelegramThreadId("")).toBeUndefined();
    expect(parseTelegramThreadId(null)).toBeUndefined();
    expect(parseTelegramThreadId(undefined)).toBeUndefined();
  });
});

describe("normalizeTelegramReplyToMessageId", () => {
  it("accepts positive finite numbers", () => {
    expect(normalizeTelegramReplyToMessageId(42)).toBe(42);
    expect(normalizeTelegramReplyToMessageId(1)).toBe(1);
    expect(normalizeTelegramReplyToMessageId(1.9)).toBe(1);
  });

  it("rejects zero and negative numbers", () => {
    expect(normalizeTelegramReplyToMessageId(0)).toBeUndefined();
    expect(normalizeTelegramReplyToMessageId(-1)).toBeUndefined();
  });

  it("rejects non-finite numbers", () => {
    expect(normalizeTelegramReplyToMessageId(Infinity)).toBeUndefined();
    expect(normalizeTelegramReplyToMessageId(NaN)).toBeUndefined();
  });

  it("rejects non-numeric types", () => {
    expect(normalizeTelegramReplyToMessageId(undefined)).toBeUndefined();
    expect(normalizeTelegramReplyToMessageId(null)).toBeUndefined();
    expect(normalizeTelegramReplyToMessageId({})).toBeUndefined();
  });

  it("accepts numeric strings with positive value", () => {
    expect(normalizeTelegramReplyToMessageId("99")).toBe(99);
  });

  it("rejects zero and negative strings", () => {
    expect(normalizeTelegramReplyToMessageId("0")).toBeUndefined();
    expect(normalizeTelegramReplyToMessageId("-5")).toBeUndefined();
  });

  it("rejects UUID and non-numeric strings", () => {
    expect(
      normalizeTelegramReplyToMessageId("550e8400-e29b-41d4-a716-446655440000"),
    ).toBeUndefined();
  });
});

describe("parseTelegramReplyToMessageId", () => {
  it("parses valid positive reply-to message ids", () => {
    expect(parseTelegramReplyToMessageId("123")).toBe(123);
    expect(parseTelegramReplyToMessageId("1")).toBe(1);
  });

  it("returns undefined for missing reply-to ids", () => {
    expect(parseTelegramReplyToMessageId(null)).toBeUndefined();
  });

  it("returns undefined for non-positive reply-to ids", () => {
    expect(parseTelegramReplyToMessageId("0")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("-1")).toBeUndefined();
  });

  it("returns undefined for non-numeric strings like UUIDs", () => {
    expect(parseTelegramReplyToMessageId("550e8400-e29b-41d4-a716-446655440000")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("abc")).toBeUndefined();
  });
});
