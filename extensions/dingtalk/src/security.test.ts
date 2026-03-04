/**
 * DingTalk security: sign verification, DM policy.
 */

import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDingTalkSign, authorizeUserForDm } from "./security.js";

describe("verifyDingTalkSign", () => {
  it("returns true for valid sign", () => {
    const timestamp = String(Date.now());
    const appSecret = "secret123";
    const stringToSign = `${timestamp}\n${appSecret}`;
    const hmac = crypto.createHmac("sha256", appSecret);
    hmac.update(stringToSign);
    const sign = hmac.digest("base64");
    expect(verifyDingTalkSign({ timestamp, sign, appSecret })).toBe(true);
  });

  it("returns false for wrong sign", () => {
    const timestamp = String(Date.now());
    const appSecret = "secret123";
    expect(verifyDingTalkSign({ timestamp, sign: "invalid", appSecret })).toBe(false);
  });

  it("returns false for expired timestamp", () => {
    const timestamp = String(Date.now() - 2 * 60 * 60 * 1000);
    const appSecret = "secret123";
    const stringToSign = `${timestamp}\n${appSecret}`;
    const hmac = crypto.createHmac("sha256", appSecret);
    hmac.update(stringToSign);
    const sign = hmac.digest("base64");
    expect(verifyDingTalkSign({ timestamp, sign, appSecret })).toBe(false);
  });
});

describe("authorizeUserForDm", () => {
  it("allows when policy is open", () => {
    expect(authorizeUserForDm("user1", "open", [])).toEqual({ allowed: true });
  });

  it("denies when allowlist is empty and policy is allowlist", () => {
    expect(authorizeUserForDm("user1", "allowlist", [])).toEqual({
      allowed: false,
      reason: "allowlist-empty",
    });
  });

  it("allows when user is in allowlist", () => {
    expect(authorizeUserForDm("user1", "allowlist", ["user1", "user2"])).toEqual({ allowed: true });
  });

  it("denies when user is not in allowlist", () => {
    expect(authorizeUserForDm("user3", "allowlist", ["user1", "user2"])).toEqual({
      allowed: false,
      reason: "not-allowlisted",
    });
  });
});
