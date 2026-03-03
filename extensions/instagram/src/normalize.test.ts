import { describe, expect, it } from "vitest";
import {
  looksLikeInstagramTargetId,
  normalizeInstagramMessagingTarget,
  normalizeInstagramUsername,
} from "./normalize.js";

describe("instagram normalize", () => {
  it("normalizes usernames", () => {
    expect(normalizeInstagramUsername("@RyLeNa")).toBe("rylena");
    expect(normalizeInstagramUsername("instagram:@Test.User")).toBe("test.user");
  });

  it("normalizes targets", () => {
    expect(normalizeInstagramMessagingTarget("@demo")).toBe("user:demo");
    expect(normalizeInstagramMessagingTarget("thread:12345")).toBe("thread:12345");
    expect(normalizeInstagramMessagingTarget("ig:thread:abc")).toBe("thread:abc");
  });

  it("recognizes valid ids", () => {
    expect(looksLikeInstagramTargetId("@demo")).toBe(true);
    expect(looksLikeInstagramTargetId("thread:12345")).toBe(true);
    expect(looksLikeInstagramTargetId("not valid target!")).toBe(false);
  });
});
