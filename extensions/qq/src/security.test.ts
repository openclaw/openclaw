/**
 * QQ security: Ed25519 sign/verify from clientSecret.
 */

import { describe, expect, it } from "vitest";
import { verifyQQSignature, signQQVerification, authorizeUserForQQ } from "./security.js";

describe("QQ sign and verify", () => {
  const clientSecret = "test-secret-naOC0ocQE3shWLAfffVLB1rhYPG7";
  const timestamp = "1636373772";
  const body = '{"op":0,"d":{},"t":"MESSAGE_CREATE"}';

  it("signQQVerification returns hex string", async () => {
    const sig = await signQQVerification("plain-token-123", clientSecret);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it("verifyQQSignature accepts body and timestamp", async () => {
    const sig = await signQQVerification(timestamp + body, clientSecret);
    const valid = await verifyQQSignature({
      timestamp,
      body,
      signatureHex: sig,
      clientSecret,
    });
    expect(valid).toBe(true);
  });
});

describe("authorizeUserForQQ", () => {
  it("allows when policy is open", () => {
    expect(authorizeUserForQQ("user1", "open", [])).toEqual({ allowed: true });
  });

  it("denies when allowlist empty and policy allowlist", () => {
    expect(authorizeUserForQQ("user1", "allowlist", [])).toEqual({
      allowed: false,
      reason: "allowlist-empty",
    });
  });

  it("allows when user in allowlist", () => {
    expect(authorizeUserForQQ("u1", "allowlist", ["u1", "u2"])).toEqual({ allowed: true });
  });
});
