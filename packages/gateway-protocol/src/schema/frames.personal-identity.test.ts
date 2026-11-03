import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { HelloOkSchema } from "./frames.js";
import { validateConnectParams } from "../validator-registry.js";

const baseConnect = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: "gateway-client",
    version: "test",
    platform: "macOS",
    mode: "backend",
  },
  personalIdentity: {
    mode: "personal-identity",
    provider: "tailscale",
    phase: "use",
    bindingId: "binding-1",
    profileId: "profile-1",
    gatewayId: "gateway-1",
    issuedAtMs: 1,
  },
};

describe("personal identity handshake declaration", () => {
  it("accepts the explicit bind and use phases", () => {
    expect(validateConnectParams(baseConnect)).toBe(true);
    expect(
      validateConnectParams({
        ...baseConnect,
        personalIdentity: {
          mode: "personal-identity",
          provider: "tailscale",
          phase: "bind",
          bindingId: "binding-1",
          issuedAtMs: 1,
        },
      }),
    ).toBe(true);
  });

  it("rejects unknown identity modes and undeclared authority fields", () => {
    expect(
      validateConnectParams({
        ...baseConnect,
        personalIdentity: { ...baseConnect.personalIdentity, mode: "shared" },
      }),
    ).toBe(false);
    expect(
      validateConnectParams({
        ...baseConnect,
        personalIdentity: { ...baseConnect.personalIdentity, account_id: "account-1" },
      }),
    ).toBe(false);
    expect(
      validateConnectParams({
        ...baseConnect,
        personalIdentity: { ...baseConnect.personalIdentity, provider: "openclaw-id" },
      }),
    ).toBe(false);
  });

  it("returns a bounded local profile binding without an OpenClaw ID account", () => {
    const bindingSchema = HelloOkSchema.properties.personalIdentityBinding;
    expect(
      Value.Check(bindingSchema, {
        mode: "personal-identity",
        provider: "tailscale",
        bindingId: "binding-1",
        profileId: "profile-1",
        gatewayId: "gateway-1",
        tlsFingerprint: "ab:".repeat(31) + "ab",
      }),
    ).toBe(true);
    expect(
      Value.Check(bindingSchema, {
        mode: "personal-identity",
        provider: "tailscale",
        bindingId: "binding-1",
        profileId: "profile-1",
        gatewayId: "gateway-1",
        tlsFingerprint: "ab:".repeat(31) + "ab",
        account_id: "account-1",
      }),
    ).toBe(false);
  });
});
