import { describe, expect, test } from "vitest";
import { validateConnectParams } from "./index.js";
import {
  HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH,
  HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH,
  HANDSHAKE_SHARED_SECRET_MAX_LENGTH,
} from "./schema/primitives.js";

const baseConnectParams = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: "test",
    version: "1.0.0",
    platform: "test",
    mode: "test",
  },
  caps: [],
  commands: [],
  role: "operator",
  scopes: ["operator.read"],
};

describe("connect frame auth field bounds", () => {
  test("accepts auth fields at the documented maximum lengths", () => {
    const sharedSecretAtCap = "a".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH);
    const bootstrapTokenAtCap = "b".repeat(HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH);
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: {
        token: sharedSecretAtCap,
        bootstrapToken: bootstrapTokenAtCap,
        deviceToken: bootstrapTokenAtCap,
        password: sharedSecretAtCap,
      },
    });
    expect(ok).toBe(true);
  });

  test("rejects oversized auth.token before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { token: "a".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects oversized auth.bootstrapToken before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { bootstrapToken: "a".repeat(HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects oversized auth.deviceToken before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { deviceToken: "a".repeat(HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects oversized auth.password before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { password: "a".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects a 60KB bootstrap token (representative attacker payload)", () => {
    // The connect frame is capped at 64KB total (MAX_PREAUTH_PAYLOAD_BYTES)
    // so an attacker could fit a ~60KB bootstrap token in the schema-pre-cap
    // world. Confirm the cap rejects it long before safeEqualSecret pads
    // every stored bootstrap token comparison up to 60KB.
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { bootstrapToken: "x".repeat(60_000) },
    });
    expect(ok).toBe(false);
  });

  test("accepts runtime tokens in their minted shapes and at the cap", () => {
    // approvalRuntimeToken mints as a 43-char base64url HMAC digest;
    // agentRuntimeIdentityToken mints as `<base64url payload>.<base64url sig>`.
    const approvalShaped = "Fk3nT_9qL-xZ0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0";
    const identityShaped = `${"eyJraW5kIjoiYWdlbnQtcnVudGltZSJ9".repeat(8)}.${approvalShaped}`;
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: {
        approvalRuntimeToken: approvalShaped,
        agentRuntimeIdentityToken: identityShaped,
      },
    });
    expect(ok).toBe(true);
    const okAtCap = validateConnectParams({
      ...baseConnectParams,
      auth: {
        approvalRuntimeToken: "a".repeat(HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH),
        agentRuntimeIdentityToken: "b".repeat(HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH),
      },
    });
    expect(okAtCap).toBe(true);
  });

  test("rejects oversized auth.approvalRuntimeToken before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { approvalRuntimeToken: "a".repeat(HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects oversized auth.agentRuntimeIdentityToken before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { agentRuntimeIdentityToken: "a".repeat(HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects non-ASCII input on machine-minted token fields", () => {
    // Machine tokens are base64url/hex/UUID-shaped; the printable-ASCII shape
    // is what makes their maxLength a true byte bound.
    for (const field of [
      "bootstrapToken",
      "deviceToken",
      "approvalRuntimeToken",
      "agentRuntimeIdentityToken",
    ]) {
      const ok = validateConnectParams({
        ...baseConnectParams,
        auth: { [field]: "abc\u00e9" },
      });
      expect(ok, `expected non-ASCII ${field} to be rejected`).toBe(false);
    }
  });

  test("rejects a single-grapheme combining-mark payload on every auth field (byte-bound regression)", () => {
    // TypeBox maxLength counts grapheme clusters, and one base char plus N
    // combining marks is a single grapheme. Without charset/code-point
    // bounding this ~120KB-byte value passes every maxLength cap and reaches
    // safeEqualSecret, which pads comparisons to byte length.
    const singleGraphemeBomb = `a${"\u0301".repeat(60_000)}`;
    for (const field of [
      "token",
      "password",
      "bootstrapToken",
      "deviceToken",
      "approvalRuntimeToken",
      "agentRuntimeIdentityToken",
    ]) {
      const ok = validateConnectParams({
        ...baseConnectParams,
        auth: { [field]: singleGraphemeBomb },
      });
      expect(ok, `expected combining-mark bomb in ${field} to be rejected`).toBe(false);
    }
  });

  test("keeps accepting non-ASCII operator passphrases within bounds", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { token: "sésame ouvre-toi \u{1F511}", password: "pässwörd" },
    });
    expect(ok).toBe(true);
  });

  test("bounds shared secrets by code points, not graphemes", () => {
    // 4-byte emoji count one code point each under the `u`-flag pattern
    // quantifier, so the cap stays a hard byte bound (<= 4 bytes per point).
    const atCap = "\u{1F511}".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH);
    const overCap = "\u{1F511}".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH + 1);
    expect(validateConnectParams({ ...baseConnectParams, auth: { token: atCap } })).toBe(true);
    expect(validateConnectParams({ ...baseConnectParams, auth: { token: overCap } })).toBe(false);
  });
});
