// Line tests cover signature plugin behavior.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateLineSignature } from "./signature.js";

function sign(body: string, secret: string): string {
  return crypto.createHmac("SHA256", secret).update(body).digest("base64");
}

describe("validateLineSignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify({ events: [{ type: "message" }] });
    const secret = "top-secret";

    expect(validateLineSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects mismatched signatures at equal and different lengths", () => {
    const body = JSON.stringify({ events: [{ type: "message" }] });
    const secret = "top-secret";

    expect(validateLineSignature(body, "short", secret)).toBe(false);
    expect(validateLineSignature(body, "x".repeat(sign(body, secret).length), secret)).toBe(false);
  });
});
