import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseRateLimitResetTimestamp, isPeriodicQuotaError } from "./rate-limit-reset-parser.js";

const NOW = new Date("2026-06-29T12:00:00Z").getTime();

test("parses 'reset at YYYY-MM-DD HH:MM:SS' format (ZAI/ZhipuAI)", () => {
  const raw = "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-02 17:39:49";
  const result = parseRateLimitResetTimestamp(raw, NOW);
  assert.notEqual(result, null);
  assert.ok(result! > 2 * 24 * 60 * 60 * 1000); // > 2 days
  assert.ok(result! < 4 * 24 * 60 * 60 * 1000); // < 4 days
});

test("parses ISO 8601 'reset at' format with Z suffix", () => {
  const raw = "Rate limit exceeded. Resets at 2026-07-02T17:39:49Z";
  const result = parseRateLimitResetTimestamp(raw, NOW);
  assert.notEqual(result, null);
  assert.ok(result! > 2 * 24 * 60 * 60 * 1000);
});

test("parses 'retry after N seconds' format", () => {
  const raw = "Rate limited. Retry after 3600 seconds.";
  const result = parseRateLimitResetTimestamp(raw, NOW);
  assert.notEqual(result, null);
  assert.ok(Math.abs(result! - 3600_000) < 1000);
});

test("parses 'Retry-After: 60' header-style text", () => {
  const raw = "Retry-After: 120";
  const result = parseRateLimitResetTimestamp(raw, NOW);
  assert.notEqual(result, null);
  assert.ok(Math.abs(result! - 120_000) < 1000);
});

test("returns null for errors without reset info", () => {
  assert.equal(parseRateLimitResetTimestamp("Too many requests", NOW), null);
  assert.equal(parseRateLimitResetTimestamp("429 Service temporarily overloaded", NOW), null);
  assert.equal(parseRateLimitResetTimestamp("", NOW), null);
  assert.equal(parseRateLimitResetTimestamp(undefined, NOW), null);
});

test("returns null for very short durations (< 30s)", () => {
  const raw = "Retry-After: 10";
  assert.equal(parseRateLimitResetTimestamp(raw, NOW), null);
});

test("clamps to 7 days max", () => {
  const raw = "Your limit will reset at 2027-01-01 00:00:00";
  const result = parseRateLimitResetTimestamp(raw, NOW);
  assert.notEqual(result, null);
  assert.ok(result! <= 7 * 24 * 60 * 60 * 1000);
});

test("isPeriodicQuotaError detects weekly limits", () => {
  assert.equal(
    isPeriodicQuotaError("Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-02"),
    true,
  );
  assert.equal(isPeriodicQuotaError("Daily limit reached"), true);
  assert.equal(isPeriodicQuotaError("Monthly usage limit exceeded"), true);
  assert.equal(isPeriodicQuotaError("Too many requests"), false);
  assert.equal(isPeriodicQuotaError("Service temporarily overloaded"), false);
});

test("handles JSON reset_after_seconds field", () => {
  const raw = '{"error":{"reset_after_seconds":3600}}';
  const result = parseRateLimitResetTimestamp(raw, NOW);
  assert.notEqual(result, null);
  assert.ok(Math.abs(result! - 3600_000) < 1000);
});

test("handles JSON reset_at ISO field", () => {
  const raw = '{"error":{"reset_at":"2026-07-02T17:39:49Z"}}';
  const result = parseRateLimitResetTimestamp(raw, NOW);
  assert.notEqual(result, null);
  assert.ok(result! > 2 * 24 * 60 * 60 * 1000);
});
