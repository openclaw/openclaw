import { describe, expect, it } from "vitest";
import { buildDailyflowsSignature, isDailyflowsSignatureValid } from "./signature.js";

describe("dailyflows signature", () => {
  it("accepts a valid signature", () => {
    const secret = "test-secret";
    const timestamp = "1712345678901";
    const body = JSON.stringify({ hello: "world" });
    const signature = buildDailyflowsSignature(secret, timestamp, body);
    expect(isDailyflowsSignatureValid({ secret, timestamp, signature, body })).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const secret = "test-secret";
    const timestamp = "1712345678901";
    const body = JSON.stringify({ hello: "world" });
    const signature = buildDailyflowsSignature(secret, timestamp, body);
    expect(
      isDailyflowsSignatureValid({
        secret,
        timestamp,
        signature: signature.replace("v1=", "v1=deadbeef"),
        body,
      }),
    ).toBe(false);
  });
});
