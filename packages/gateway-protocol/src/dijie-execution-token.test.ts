import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDijieExecutionToken } from "./dijie-execution-token.js";

const keyPair = crypto.generateKeyPairSync("ed25519");
const privateKeyPem = keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicKeyPem = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
const nowMs = 1_800_000_000_000;

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function createToken(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: "dijie-execution-token-v1",
    ...headerOverrides,
  };
  const payload = {
    iss: "dijie-cloud",
    typ: "dijie_execution",
    executionId: "exec_123",
    actorId: "cus_123",
    roleListingId: "role_developer_agent",
    packageId: "pkg_developer_agent",
    packageVersion: "1.0.0",
    developerRef: "dev_001",
    listingOwnerRef: "seller_001",
    billingBeneficiaryRef: "dev_001",
    entitlementId: "ent_123",
    deviceId: "device_123",
    workspaceRef: "workspace_123",
    localGatewayId: "gateway_123",
    scopes: ["role.execute"],
    pricing: {
      kind: "one_time_authorization",
      authorizationFeeCents: 29900,
      currency: "CNY",
      platformFeeBps: 0,
      developerReceivableCents: 29900,
    },
    roleTokenPricing: {
      inputTokenCentsPerMillion: 120,
      outputTokenCentsPerMillion: 480,
      currency: "CNY",
      developerReceivableBps: 10000,
      platformFeeBps: 0,
    },
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 300,
    ...payloadOverrides,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
}

describe("verifyDijieExecutionToken", () => {
  it("verifies an Ed25519 signed execution token with one-time authorization pricing", () => {
    const result = verifyDijieExecutionToken(createToken(), publicKeyPem, nowMs + 1_000);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.claims.actorId).toBe("cus_123");
    expect(result.claims.packageVersion).toBe("1.0.0");
    expect(result.claims.billingBeneficiaryRef).toBe("dev_001");
    expect(result.claims.pricing.kind).toBe("one_time_authorization");
    expect(result.claims.roleTokenPricing).toMatchObject({
      inputTokenCentsPerMillion: 120,
      outputTokenCentsPerMillion: 480,
      developerReceivableBps: 10000,
      platformFeeBps: 0,
    });
  });

  it("accepts escaped PEM newlines from environment variables", () => {
    expect(
      verifyDijieExecutionToken(createToken(), publicKeyPem.replace(/\n/g, "\\n"), nowMs + 1_000)
        .ok,
    ).toBe(true);
  });

  it("rejects tampered tokens", () => {
    const token = `${createToken().slice(0, -2)}xx`;

    expect(verifyDijieExecutionToken(token, publicKeyPem, nowMs + 1_000)).toEqual({
      ok: false,
      error: "Invalid Dijie execution token signature.",
    });
  });

  it("rejects expired tokens", () => {
    const token = createToken({ exp: Math.floor(nowMs / 1000) - 1 });

    expect(verifyDijieExecutionToken(token, publicKeyPem, nowMs)).toEqual({
      ok: false,
      error: "Dijie execution token expired.",
    });
  });

  it("rejects runtime-duration pricing claims", () => {
    const token = createToken({
      pricing: {
        kind: "runtime_duration",
        centsPerMinute: 20,
        currency: "CNY",
      },
    });

    expect(verifyDijieExecutionToken(token, publicKeyPem, nowMs + 1_000)).toEqual({
      ok: false,
      error: "Invalid Dijie execution token claims.",
    });
  });

  it("rejects marketplace platform cuts in pricing claims", () => {
    const token = createToken({
      pricing: {
        kind: "one_time_authorization",
        authorizationFeeCents: 29900,
        currency: "CNY",
        platformFeeBps: 1500,
        developerReceivableCents: 25415,
      },
    });

    expect(verifyDijieExecutionToken(token, publicKeyPem, nowMs + 1_000)).toEqual({
      ok: false,
      error: "Invalid Dijie execution token claims.",
    });
  });

  it("rejects execution tokens without role token pricing", () => {
    const token = createToken({ roleTokenPricing: undefined });

    expect(verifyDijieExecutionToken(token, publicKeyPem, nowMs + 1_000)).toEqual({
      ok: false,
      error: "Invalid Dijie execution token claims.",
    });
  });

  it("rejects invalid role token pricing claims", () => {
    for (const roleTokenPricing of [
      {
        inputTokenCentsPerMillion: -1,
        outputTokenCentsPerMillion: 480,
        currency: "CNY",
        developerReceivableBps: 10000,
        platformFeeBps: 0,
      },
      {
        inputTokenCentsPerMillion: 120,
        outputTokenCentsPerMillion: 480,
        currency: "",
        developerReceivableBps: 10000,
        platformFeeBps: 0,
      },
      {
        inputTokenCentsPerMillion: 120,
        outputTokenCentsPerMillion: 480,
        currency: "CNY",
        developerReceivableBps: 8500,
        platformFeeBps: 1500,
      },
    ]) {
      expect(
        verifyDijieExecutionToken(createToken({ roleTokenPricing }), publicKeyPem, nowMs + 1_000),
      ).toEqual({
        ok: false,
        error: "Invalid Dijie execution token claims.",
      });
    }
  });

  it("rejects unsupported signing headers", () => {
    const token = createToken({}, { alg: "HS256" });

    expect(verifyDijieExecutionToken(token, publicKeyPem, nowMs + 1_000)).toEqual({
      ok: false,
      error: "Unsupported Dijie execution token header.",
    });
  });
});
