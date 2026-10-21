import * as oidc from "openid-client";
import { expect, it } from "vitest";
import { discoverMcpEnterpriseIdp, type McpEnterpriseConfig } from "./mcp-enterprise.js";
import { buildMcpOAuthHttpFetch } from "./mcp-http-fetch.js";

it("keeps OIDC token grants on the guarded fetch after untrusted discovery", async () => {
  const issuer = "https://idp.example.test";
  const tokenEndpoint = "https://127.0.0.1:40104/token";
  const config: McpEnterpriseConfig = {
    identity: "shared",
    idpIssuer: issuer,
    idpClientId: "fixture-client",
    idpClientSecret: "fixture-secret",
    resourceIssuer: "https://auth.example.test",
    resourceClientId: "fixture-resource-client",
    resourceClientSecret: "fixture-resource-secret",
    scope: "mcp.read",
    redirectUrl: "http://localhost:3097/callback",
  };
  const guardedFetch = buildMcpOAuthHttpFetch({ resourceUrl: issuer, timeoutMs: 1_000 });
  const requested: string[] = [];
  const discovered = await discoverMcpEnterpriseIdp(config, (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input).href;
    requested.push(url);
    if (url.startsWith(`${issuer}/.well-known/`)) {
      return Promise.resolve(
        Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: tokenEndpoint,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
    }
    return guardedFetch(input, init);
  });
  await expect(oidc.refreshTokenGrant(discovered, "fixture-refresh")).rejects.toThrow();
  expect(requested).toContain(tokenEndpoint);
  await expect(guardedFetch(tokenEndpoint, { method: "POST" })).rejects.toThrow(/private/i);
});
