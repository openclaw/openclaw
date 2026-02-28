import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGHLSignature } from "./auth.js";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyGHLSignature", () => {
  const secret = "test-webhook-secret";
  const body = '{"type":"InboundMessage","contactId":"abc123"}';

  it("accepts a valid signature", () => {
    const signature = sign(body, secret);
    expect(verifyGHLSignature({ signature, body, secret })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = sign(body, secret);
    expect(verifyGHLSignature({ signature, body: body + "x", secret })).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const signature = sign(body, "wrong-secret");
    expect(verifyGHLSignature({ signature, body, secret })).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(verifyGHLSignature({ signature: "", body, secret })).toBe(false);
  });

  it("rejects empty secret", () => {
    const signature = sign(body, secret);
    expect(verifyGHLSignature({ signature, body, secret: "" })).toBe(false);
  });

  it("rejects signature with wrong length", () => {
    expect(verifyGHLSignature({ signature: "abc", body, secret })).toBe(false);
  });
});
