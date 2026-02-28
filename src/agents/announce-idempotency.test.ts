import { describe, expect, it } from "vitest";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";

describe("buildAnnounceIdempotencyKey", () => {
  it("creates consistent keys", () => {
    const key1 = buildAnnounceIdempotencyKey("test-123");
    const key2 = buildAnnounceIdempotencyKey("test-123");
    expect(key1).toBe(key2);
  });
});
