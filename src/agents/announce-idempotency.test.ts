import { expect, it } from "vitest";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";

it("preserves announce keys through the 256-character admission limit", () => {
  for (const length of [1, 246, 247]) {
    const announceId = "x".repeat(length);
    expect(buildAnnounceIdempotencyKey(announceId)).toBe(`announce:${announceId}`);
  }
});

it("bounds the whole identity while preserving routing and continuation markers", () => {
  const cohort = `requester-settle:main:${"child,".repeat(60)}`;
  const keys = new Set<string>();
  for (const suffix of ["", ":yield-1", ":yield-2:pause", ":retry-1", ":retry-2", ":wake"]) {
    const announceId = `${cohort}${suffix}`;
    const key = buildAnnounceIdempotencyKey(announceId);
    expect(key.length).toBeLessThanOrEqual(256);
    expect(key.startsWith("announce:requester-settle:")).toBe(true);
    expect(key.endsWith(suffix)).toBe(true);
    expect(buildAnnounceIdempotencyKey(announceId)).toBe(key);
    keys.add(key);
  }
  expect(keys.size).toBe(6);
  expect(buildAnnounceIdempotencyKey(`${cohort}other`)).not.toBe(
    buildAnnounceIdempotencyKey(cohort),
  );
  const unicodeKey = buildAnnounceIdempotencyKey(`v1:${"🦞".repeat(150)}:wake:wake`);
  expect(unicodeKey.length).toBeLessThanOrEqual(256);
  expect(unicodeKey.isWellFormed()).toBe(true);
  expect(unicodeKey.endsWith(":wake")).toBe(true);
});
