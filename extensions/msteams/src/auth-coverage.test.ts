// Exercise the Teams SDK's real JWT validators against locally signed tokens and JWKS.
// Internal SDK imports pin audience validation and the v1 Entra issuer regression (#76262).
// HTTP routing is covered by monitor.lifecycle.test.ts.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PUBLIC, withOverrides } from "@microsoft/teams.api/dist/auth/cloud-environment.js";
import { InboundActivityTokenValidator } from "@microsoft/teams.apps/dist/middleware/auth/inbound-activity-token-validator.js";
import {
  createEntraTokenValidator,
  JwtValidator,
} from "@microsoft/teams.apps/dist/middleware/auth/jwt-validator.js";
import type { ILogger } from "@microsoft/teams.common";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_ID = "test-app-id";
const TENANT_ID = "test-tenant-id";
const TEST_KID = "test-key-id";

let privateKey: CryptoKey;
let jwksServer: Server;
// Entra appends its tenant JWKS path, so this endpoint must have no path.
let loginEndpoint: string;
let openIdMetadataUrl: string;
let jwksUri: string;

async function mintToken(iss: string, claims: Record<string, unknown> = {}): Promise<string> {
  return await new SignJWT({ aud: APP_ID, iss, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = priv;
  const jwk = { ...(await exportJWK(publicKey)), kid: TEST_KID, alg: "RS256", use: "sig" };
  const jwksDocument = JSON.stringify({ keys: [jwk] });

  jwksServer = createServer((req, res) => {
    if (req.url?.endsWith("/keys") || req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jwksDocument);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    jwksServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = jwksServer.address() as AddressInfo;
  loginEndpoint = `http://127.0.0.1:${port}`;
  openIdMetadataUrl = `${loginEndpoint}/v1/.well-known/openidconfiguration`;
  jwksUri = `${loginEndpoint}/jwks`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((err) => (err ? reject(err) : resolve()));
  });
});

// Surface rejection reasons without the SDK's routine diagnostics.
const debugLogger: ILogger = {
  child: () => debugLogger,
  debug: () => {},
  info: () => {},
  error: (...args: unknown[]) => console.error("[sdk]", ...args),
  warn: () => {},
  log: () => {},
  trace: () => {},
};

describe("InboundActivityTokenValidator (inbound Bot Framework)", () => {
  const validator = (logger?: ILogger) =>
    new InboundActivityTokenValidator(
      APP_ID,
      undefined,
      undefined,
      logger,
      withOverrides(PUBLIC, { openIdMetadataUrl }),
    );

  it("accepts a token whose audience matches the bot app id", async () => {
    const token = await mintToken("https://api.botframework.com");
    const result = await validator(debugLogger).check(`Bearer ${token}`, { id: "activity-1" });
    expect(result.appId).toBe(APP_ID);
  });

  it("rejects a token with aud=api.botframework.com even when the appid claim matches the bot", async () => {
    // Connector-resource tokens must fail even when appid/azp identify this bot.
    const token = await mintToken("https://api.botframework.com", {
      aud: "https://api.botframework.com",
      appid: APP_ID,
      azp: APP_ID,
    });

    await expect(validator().check(`Bearer ${token}`, { id: "activity-2" })).rejects.toThrow();
  });
});

describe("createEntraTokenValidator (Entra access tokens — SDK 2.0.10 v1 issuer fix)", () => {
  const validator = () =>
    createEntraTokenValidator(TENANT_ID, APP_ID, {
      allowedTenantIds: [TENANT_ID],
      loginEndpoint,
    });

  it("accepts the v1 sts.windows.net issuer for an allowed tenant", async () => {
    const token = await mintToken(`https://sts.windows.net/${TENANT_ID}/`);

    const payload = await validator().validateAccessToken(token);

    expect(payload).not.toBeNull();
    expect(payload?.iss).toBe(`https://sts.windows.net/${TENANT_ID}/`);
  });

  it("accepts the v2 login.microsoftonline.com issuer for an allowed tenant", async () => {
    // Explicit JWKS URI decouples local keys from the public v2 issuer allowlist;
    // createEntraTokenValidator instead ties both to loginEndpoint.
    const v2Validator = new JwtValidator(
      {
        clientId: APP_ID,
        tenantId: TENANT_ID,
        loginEndpoint: "https://login.microsoftonline.com",
        validateIssuer: { allowedTenantIds: [TENANT_ID] },
        jwksUriOptions: { type: "uri", uri: jwksUri },
      },
      debugLogger,
    );
    const token = await mintToken(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`);

    const payload = await v2Validator.validateAccessToken(token);

    expect(payload).not.toBeNull();
    expect(payload?.iss).toBe(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`);
  });

  it("rejects an issuer for a tenant that is not allowed", async () => {
    const token = await mintToken("https://sts.windows.net/some-other-tenant-id/");

    const payload = await validator().validateAccessToken(token);
    expect(payload).toBeNull();
  });
});
