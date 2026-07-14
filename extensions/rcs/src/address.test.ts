// Rcs tests cover address plugin behavior.
import { describe, expect, it } from "vitest";
import {
  isRcsWireAddress,
  looksLikeRcsTarget,
  normalizeRcsAllowFrom,
  normalizeRcsIdentity,
  normalizeRcsSenderId,
  toRcsWireAddress,
} from "./address.js";

describe("RCS address normalization", () => {
  it("normalizes rcs-prefixed addresses to bare E.164 identities", () => {
    expect(normalizeRcsIdentity("rcs:+15551234567")).toBe("+15551234567");
    expect(normalizeRcsIdentity("RCS:+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeRcsIdentity("+15551234567")).toBe("+15551234567");
    expect(normalizeRcsIdentity("sms:+15551234567")).toBe("+15551234567");
    expect(normalizeRcsIdentity("15551234567")).toBe("+15551234567");
  });

  it("does not produce malformed ++E164 identities", () => {
    expect(normalizeRcsIdentity("rcs:+15551234567")).not.toContain("++");
  });

  it("builds wire addresses with the rcs prefix", () => {
    expect(toRcsWireAddress("+15551234567")).toBe("rcs:+15551234567");
    expect(toRcsWireAddress("rcs:+15551234567")).toBe("rcs:+15551234567");
    expect(toRcsWireAddress("")).toBe("");
  });

  it("detects wire addresses", () => {
    expect(isRcsWireAddress("rcs:+15551234567")).toBe(true);
    expect(isRcsWireAddress("+15551234567")).toBe(false);
  });

  it("normalizes sender ids", () => {
    expect(normalizeRcsSenderId("myagent_abc_agent")).toBe("rcs:myagent_abc_agent");
    expect(normalizeRcsSenderId("rcs:myagent_abc_agent")).toBe("rcs:myagent_abc_agent");
    expect(normalizeRcsSenderId("")).toBe("");
  });

  it("validates E.164-ish RCS targets", () => {
    expect(looksLikeRcsTarget("+15551234567")).toBe(true);
    expect(looksLikeRcsTarget("rcs:+15551234567")).toBe(true);
    expect(looksLikeRcsTarget("+01234567")).toBe(false);
    expect(looksLikeRcsTarget("+1555")).toBe(false);
  });

  it("normalizes allowFrom entries", () => {
    expect(normalizeRcsAllowFrom("rcs:+15551234567")).toBe("+15551234567");
    expect(normalizeRcsAllowFrom("*")).toBe("*");
  });
});
