import { describe, expect, it } from "vitest";
import {
  extractNextcloudTalkHeaders,
  generateNextcloudTalkSignature,
  verifyNextcloudTalkSignature,
} from "./signature.js";

const TEST_SECRET = "nextcloud-secret"; // pragma: allowlist secret

describe("verifyNextcloudTalkSignature", () => {
  it("accepts a valid signature", () => {
    const body = '{"type":"Create"}';
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: TEST_SECRET });
    expect(verifyNextcloudTalkSignature({ signature, random, body, secret: TEST_SECRET })).toBe(
      true,
    );
  });

  it("rejects a tampered body", () => {
    const body = '{"type":"Create"}';
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: TEST_SECRET });
    expect(
      verifyNextcloudTalkSignature({
        signature,
        random,
        body: '{"type":"Delete"}',
        secret: TEST_SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const body = '{"type":"Create"}';
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: TEST_SECRET });
    expect(verifyNextcloudTalkSignature({ signature, random, body, secret: "wrong-secret" })).toBe(
      false,
    );
  });

  it("rejects a tampered signature", () => {
    const body = '{"type":"Create"}';
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: TEST_SECRET });
    const tampered = "a".repeat(signature.length);
    expect(
      verifyNextcloudTalkSignature({ signature: tampered, random, body, secret: TEST_SECRET }),
    ).toBe(false);
  });

  it("rejects a signature with wrong length", () => {
    const body = '{"type":"Create"}';
    const { random } = generateNextcloudTalkSignature({ body, secret: TEST_SECRET });
    expect(
      verifyNextcloudTalkSignature({ signature: "tooshort", random, body, secret: TEST_SECRET }),
    ).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(
      verifyNextcloudTalkSignature({ signature: "", random: "r", body: "b", secret: TEST_SECRET }),
    ).toBe(false);
  });

  it("rejects empty random", () => {
    expect(
      verifyNextcloudTalkSignature({ signature: "s", random: "", body: "b", secret: TEST_SECRET }),
    ).toBe(false);
  });

  it("rejects empty secret", () => {
    expect(
      verifyNextcloudTalkSignature({ signature: "s", random: "r", body: "b", secret: "" }),
    ).toBe(false);
  });
});

describe("extractNextcloudTalkHeaders", () => {
  it("extracts all three headers", () => {
    const result = extractNextcloudTalkHeaders({
      "x-nextcloud-talk-signature": "sig",
      "x-nextcloud-talk-random": "rand",
      "x-nextcloud-talk-backend": "https://nc.example",
    });
    expect(result).toEqual({
      signature: "sig",
      random: "rand",
      backend: "https://nc.example",
    });
  });

  it("returns null when signature is missing", () => {
    expect(
      extractNextcloudTalkHeaders({
        "x-nextcloud-talk-random": "rand",
        "x-nextcloud-talk-backend": "https://nc.example",
      }),
    ).toBeNull();
  });

  it("handles array header values by taking the first element", () => {
    const result = extractNextcloudTalkHeaders({
      "x-nextcloud-talk-signature": ["sig1", "sig2"],
      "x-nextcloud-talk-random": "rand",
      "x-nextcloud-talk-backend": "https://nc.example",
    });
    expect(result?.signature).toBe("sig1");
  });
});

describe("generateNextcloudTalkSignature", () => {
  it("produces a valid hex signature", () => {
    const { random, signature } = generateNextcloudTalkSignature({
      body: "test",
      secret: TEST_SECRET,
    });
    expect(random).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates different randoms on each call", () => {
    const a = generateNextcloudTalkSignature({ body: "test", secret: TEST_SECRET });
    const b = generateNextcloudTalkSignature({ body: "test", secret: TEST_SECRET });
    expect(a.random).not.toBe(b.random);
  });
});
