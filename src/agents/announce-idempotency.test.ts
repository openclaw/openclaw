import { describe, expect, it } from "vitest";
import {
  buildAnnounceIdempotencyKey,
  buildAnnounceIdFromChildRun,
  resolveQueueAnnounceId,
} from "./announce-idempotency.js";

describe("buildAnnounceIdFromChildRun", () => {
  it("combines childSessionKey and childRunId under the v1 prefix", () => {
    expect(buildAnnounceIdFromChildRun({ childSessionKey: "sess-abc", childRunId: "run-42" })).toBe(
      "v1:sess-abc:run-42",
    );
  });

  it("preserves colons inside session keys", () => {
    expect(
      buildAnnounceIdFromChildRun({
        childSessionKey: "telegram:1234:thread:7",
        childRunId: "run-1",
      }),
    ).toBe("v1:telegram:1234:thread:7:run-1");
  });
});

describe("buildAnnounceIdempotencyKey", () => {
  it("prefixes the announce id with announce:", () => {
    expect(buildAnnounceIdempotencyKey("v1:sess-abc:run-42")).toBe("announce:v1:sess-abc:run-42");
  });

  it("prefixes legacy fallback announce ids without altering them", () => {
    expect(buildAnnounceIdempotencyKey("legacy:sess-abc:1700000000000")).toBe(
      "announce:legacy:sess-abc:1700000000000",
    );
  });
});

describe("resolveQueueAnnounceId", () => {
  it("returns the supplied announce id verbatim when present and non-empty", () => {
    expect(
      resolveQueueAnnounceId({
        announceId: "v1:sess-abc:run-42",
        sessionKey: "sess-abc",
        enqueuedAt: 1700000000000,
      }),
    ).toBe("v1:sess-abc:run-42");
  });

  it("trims surrounding whitespace from a non-empty announce id", () => {
    expect(
      resolveQueueAnnounceId({
        announceId: "  v1:sess-abc:run-42  ",
        sessionKey: "sess-abc",
        enqueuedAt: 1700000000000,
      }),
    ).toBe("v1:sess-abc:run-42");
  });

  it("falls back to legacy fingerprint when announceId is whitespace-only", () => {
    expect(
      resolveQueueAnnounceId({
        announceId: "   ",
        sessionKey: "sess-abc",
        enqueuedAt: 1700000000000,
      }),
    ).toBe("legacy:sess-abc:1700000000000");
  });

  it("falls back to legacy fingerprint when announceId is an empty string", () => {
    expect(
      resolveQueueAnnounceId({
        announceId: "",
        sessionKey: "sess-abc",
        enqueuedAt: 1700000000000,
      }),
    ).toBe("legacy:sess-abc:1700000000000");
  });

  it("falls back to legacy fingerprint when announceId is undefined", () => {
    expect(resolveQueueAnnounceId({ sessionKey: "sess-abc", enqueuedAt: 1700000000000 })).toBe(
      "legacy:sess-abc:1700000000000",
    );
  });
});
