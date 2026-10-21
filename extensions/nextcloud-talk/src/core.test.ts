import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  looksLikeNextcloudTalkTargetId as looksLikeTargetId,
  normalizeNextcloudTalkMessagingTarget as normalizeTarget,
  stripNextcloudTalkTargetPrefix as stripPrefix,
} from "./normalize.js";
import { resolveNextcloudTalkAllowlistMatch as resolveAllowlistMatch } from "./policy.js";
import {
  extractNextcloudTalkHeaders as extractHeaders,
  generateNextcloudTalkSignature as generateSignature,
  verifyNextcloudTalkSignature as verifySignature,
} from "./signature.js";

function signedPayload(generate = generateSignature) {
  const payload = { body: JSON.stringify({ hello: "world" }), secret: "secret-123" };
  return { ...payload, ...generate(payload) };
}

describe("nextcloud talk core", () => {
  it("normalizes and recognizes supported room target formats", () => {
    expect(stripPrefix(" room:abc123 ")).toBe("abc123");
    expect(stripPrefix("nextcloud-talk:room:AbC123")).toBe("AbC123");
    expect(stripPrefix("nc-talk:room:ops")).toBe("ops");
    expect(stripPrefix("nc:room:ops")).toBe("ops");
    expect(stripPrefix("NC-TALK:ROOM:Ops")).toBe("Ops");
    expect(stripPrefix("room:   ")).toBeUndefined();

    expect(normalizeTarget("room:AbC123")).toBe("nextcloud-talk:abc123");
    expect(normalizeTarget("nc-talk:room:Ops")).toBe("nextcloud-talk:ops");
    expect(normalizeTarget("NEXTCLOUD-TALK:ROOM:Ops")).toBe("nextcloud-talk:ops");

    expect(looksLikeTargetId("nextcloud-talk:room:abc12345")).toBe(true);
    expect(looksLikeTargetId("nc:opsroom1")).toBe(true);
    expect(looksLikeTargetId("room:opsroom1")).toBe(true);
    expect(looksLikeTargetId("abc12345")).toBe(true);
    expect(looksLikeTargetId("")).toBe(false);
  });

  it("verifies generated signatures and extracts normalized headers", () => {
    const signed = signedPayload();

    expect(signed.random).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature(signed)).toBe(true);

    expect(
      extractHeaders({
        "x-nextcloud-talk-signature": ["sig", "ignored"],
        "x-nextcloud-talk-random": ["rand", "ignored"],
        "x-nextcloud-talk-backend": ["backend", "ignored"],
      }),
    ).toEqual({ signature: "sig", random: "rand", backend: "backend" });
    expect(
      extractHeaders({
        "X-Nextcloud-Talk-Signature": "sig",
      }),
    ).toBeNull();
  });

  it.each<[string, Partial<Parameters<typeof verifySignature>[0]>]>([
    ["empty signature", { signature: "" }],
    ["short signature", { signature: "deadbeef" }],
    ["tampered body", { body: JSON.stringify({ hello: "tampered" }) }],
    ["wrong secret", { secret: "wrong-secret" }],
    ["tampered signature", { signature: "a".repeat(64) }],
  ])("rejects %s", (_label, tampered) => {
    expect(verifySignature({ ...signedPayload(), ...tampered })).toBe(false);
  });

  it("still runs timingSafeEqual when the supplied signature length mismatches", async () => {
    const timingSafeEqualMock =
      vi.fn<(left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => void>();

    vi.resetModules();
    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:crypto")>();
      return {
        ...actual,
        timingSafeEqual: vi.fn((left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
          timingSafeEqualMock(left, right);
          return actual.timingSafeEqual(left, right);
        }),
      };
    });

    try {
      const { generateNextcloudTalkSignature: generate, verifyNextcloudTalkSignature: verify } =
        await import("./signature.js");
      const signed = signedPayload(generate);
      expect(verify({ ...signed, signature: signed.signature.slice(0, 12) })).toBe(false);

      expect(timingSafeEqualMock).toHaveBeenCalledOnce();
      const [leftBuffer, rightBuffer] = expectDefined(
        timingSafeEqualMock.mock.calls[0],
        "timingSafeEqual call",
      );
      if (!Buffer.isBuffer(leftBuffer) || !Buffer.isBuffer(rightBuffer)) {
        throw new TypeError("Expected timingSafeEqual to receive Buffer arguments");
      }
      expect(leftBuffer).toHaveLength(rightBuffer.length);
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });

  it("resolves allowlist matches", () => {
    const match = (allowFrom: string[], senderId = "user-id") =>
      resolveAllowlistMatch({ allowFrom, senderId });
    expect(match(["*"]).allowed).toBe(true);
    expect(match(["nc:User-Id"])).toEqual({
      allowed: true,
      matchKey: "user-id",
      matchSource: "id",
    });
    expect(match(["allowed"], "other").allowed).toBe(false);
  });
});
