import { describe, expect, it } from "vitest";
import {
  extractNextcloudTalkHeaders,
  generateNextcloudTalkSignature,
  verifyNextcloudTalkSignature,
} from "./signature.js";

describe("nextcloud talk signature helpers", () => {
  it("verifies generated signatures against the same body and secret", () => {
    const body = JSON.stringify({ hello: "world" });
    const generated = generateNextcloudTalkSignature({
      body,
      secret: "secret-123",
    });

    expect(generated.random).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyNextcloudTalkSignature({
        signature: generated.signature,
        random: generated.random,
        body,
        secret: "secret-123",
      }),
    ).toBe(true);
  });

  it("rejects missing fields and mismatched signatures", () => {
    expect(
      verifyNextcloudTalkSignature({
        signature: "",
        random: "abc",
        body: "body",
        secret: "secret",
      }),
    ).toBe(false);
    expect(
      verifyNextcloudTalkSignature({
        signature: "deadbeef",
        random: "abc",
        body: "body",
        secret: "secret",
      }),
    ).toBe(false);
  });

  it("extracts normalized webhook headers", () => {
    expect(
      extractNextcloudTalkHeaders({
        "x-nextcloud-talk-signature": "sig",
        "x-nextcloud-talk-random": "rand",
        "x-nextcloud-talk-backend": "backend",
      }),
    ).toEqual({
      signature: "sig",
      random: "rand",
      backend: "backend",
    });

    expect(
      extractNextcloudTalkHeaders({
        "X-Nextcloud-Talk-Signature": "sig",
      }),
    ).toBeNull();
  });
});
