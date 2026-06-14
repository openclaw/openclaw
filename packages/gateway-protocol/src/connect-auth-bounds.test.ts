import { describe, expect, test } from "vitest";
import { validateConnectParams } from "./index.js";
import {
  HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH,
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
});
