import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpConnectionAuthorityError } from "./mcp-connection-authority-error.js";
import { withMcpEnterpriseBearer } from "./mcp-enterprise-fetch.js";
import { captureMcpOAuthAuthorization } from "./mcp-oauth-authorization.js";

const oauthStore = vi.hoisted(() => ({ authorizationId: "first-login" as string | undefined }));

// mock-isolation: Keep the enterprise authorization incarnation deterministic without SQLite.
vi.mock("./mcp-oauth-store.js", () => ({
  readMcpOAuthStore: vi.fn(async () => ({
    authorizationId: oauthStore.authorizationId,
    tokens: {
      id_token: "fixture-id-token",
      token_type: "Bearer",
      access_token: "fixture-idp-token",
    },
    tokenExpiresAt: Date.now() + 300_000,
  })),
  mutateMcpOAuthStore: vi.fn(),
}));
// mock-isolation: Keep authority captures deterministic; real SQLite revocation is covered by the composed test.
vi.mock("./mcp-oauth-authorization.js", () => ({
  captureMcpOAuthAuthorization: vi.fn(async () => {
    const authorizationId = oauthStore.authorizationId;
    if (!authorizationId) {
      throw new Error("Enterprise SSO has expired. Sign in again.");
    }
    return {
      authorizationId,
      assertCurrent() {
        if (oauthStore.authorizationId !== authorizationId) {
          throw new Error("Enterprise SSO changed.");
        }
      },
      revalidate: async () => {},
      dispose() {},
    };
  }),
}));

const resource = "http://127.0.0.1:40101/mcp";
const authorizationServer = "http://127.0.0.1:40102";
const idp = "http://127.0.0.1:40103";
const metadata = `${resource}/metadata`;

beforeEach(() => {
  oauthStore.authorizationId = "first-login";
  vi.mocked(captureMcpOAuthAuthorization).mockClear();
});

function fixture(
  expectedIssuer = authorizationServer,
  tokenEndpointAuthMethod?: "client_secret_post",
  challengeScope?: string,
) {
  const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = request.url;
    const body = await request.text();
    requests.push({ url, authorization: request.headers.get("authorization"), body });
    const json = (value: unknown) => Response.json(value);
    if (url === resource) {
      return request.headers.get("authorization") === "Bearer fixture-resource-token"
        ? json({ ok: true })
        : new Response(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${metadata}"${challengeScope ? `, scope="${challengeScope}"` : ""}`,
            },
          });
    }
    if (url === `${resource}/forbidden`) {
      return new Response(null, { status: 403 });
    }
    if (url === "http://127.0.0.1:40200/other") {
      return json({ ok: true });
    }
    if (url === metadata) {
      return json({ resource, authorization_servers: [authorizationServer] });
    }
    if (url === `${authorizationServer}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: authorizationServer,
        token_endpoint: `${authorizationServer}/token`,
        authorization_endpoint: `${authorizationServer}/authorize`,
        response_types_supported: ["code"],
        authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"],
      });
    }
    if (url === `${idp}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: idp,
        token_endpoint: `${idp}/token`,
        authorization_endpoint: `${idp}/authorize`,
        response_types_supported: ["code"],
      });
    }
    if (url === `${idp}/token`) {
      const params = new URLSearchParams(body);
      expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
      expect(params.get("subject_token")).toBe("fixture-id-token");
      expect(params.get("audience")).toBe(authorizationServer);
      expect(params.get("resource")).toBe(resource);
      return json({
        access_token: "fixture-id-jag",
        issued_token_type: "urn:ietf:params:oauth:token-type:id-jag",
        token_type: "N_A",
        expires_in: 300,
      });
    }
    if (url === `${authorizationServer}/token`) {
      const params = new URLSearchParams(body);
      expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      expect(params.get("assertion")).toBe("fixture-id-jag");
      return json({
        access_token: "fixture-resource-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  const config = {
    identity: "shared" as const,
    idpIssuer: idp,
    idpClientId: "fixture-idp-client",
    idpClientSecret: "fixture-idp-secret",
    resourceIssuer: expectedIssuer,
    resourceClientId: "fixture-resource-client",
    resourceClientSecret: "fixture-resource-secret",
    scope: "mcp.read",
    redirectUrl: "http://localhost:3097/callback",
    tokenEndpointAuthMethod,
  };
  return {
    requests,
    fetch: withMcpEnterpriseBearer({
      resourceUrl: resource,
      config,
      fetchFn,
      createAuthenticatedFetches: (assertCurrent) => {
        const guardedFetch = async (input: string | URL | Request, init?: RequestInit) => {
          assertCurrent();
          return fetchFn(input, init);
        };
        return { resourceFetch: guardedFetch, authFetch: guardedFetch };
      },
    }),
  };
}

describe("enterprise MCP bearer exchange", () => {
  it("retries a concurrent first credential observation before sending the resource request", async () => {
    vi.mocked(captureMcpOAuthAuthorization).mockRejectedValueOnce(
      new McpConnectionAuthorityError("unavailable"),
    );
    const { fetch, requests } = fixture();
    expect((await fetch(resource)).status).toBe(200);
    expect(captureMcpOAuthAuthorization).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.url === resource)).toHaveLength(2);
  });

  it("rejects a challenge requesting scope outside the configured grant", async () => {
    const { fetch, requests } = fixture(authorizationServer, undefined, "mcp.write");
    await expect(fetch(resource)).rejects.toThrow(/scope/i);
    expect(requests.some((request) => request.url.endsWith("/token"))).toBe(false);
  });

  it("does not reuse a cached resource token after enterprise logout", async () => {
    oauthStore.authorizationId = "first-login";
    const { fetch, requests } = fixture();
    expect((await fetch(resource)).status).toBe(200);
    oauthStore.authorizationId = undefined;
    await expect(fetch(resource)).rejects.toThrow(/sign in|expired/i);
    expect(requests.filter((request) => request.url === resource)).toHaveLength(2);
    oauthStore.authorizationId = "second-login";
    expect((await fetch(resource)).status).toBe(200);
    expect(requests.filter((request) => request.url === `${idp}/token`)).toHaveLength(2);
  });
  it("exchanges an IdP token through ID-JAG and reuses the resource token", async () => {
    const { fetch, requests } = fixture();
    expect((await fetch(resource)).status).toBe(200);
    expect((await fetch(resource)).status).toBe(200);
    expect(requests.filter((request) => request.url === `${idp}/token`)).toHaveLength(1);
    expect(
      requests.filter((request) => request.url === `${authorizationServer}/token`),
    ).toHaveLength(1);
    expect(
      requests
        .filter((request) => request.url === resource)
        .map((request) => request.authorization),
    ).toEqual([null, "Bearer fixture-resource-token", "Bearer fixture-resource-token"]);
  });

  it("rejects an authorization server that differs from the configured issuer", async () => {
    const { fetch, requests } = fixture("http://127.0.0.1:49999");
    await expect(fetch(resource)).rejects.toThrow(/authorization server mismatch/i);
    expect(requests.some((request) => request.url.endsWith("/token"))).toBe(false);
  });

  it("supports resource servers requiring client_secret_post", async () => {
    const { fetch, requests } = fixture(authorizationServer, "client_secret_post");
    expect((await fetch(resource)).status).toBe(200);
    const redemption = requests.find((request) => request.url === `${authorizationServer}/token`);
    expect(redemption?.authorization).toBeNull();
    expect(new URLSearchParams(redemption?.body).get("client_secret")).toBe(
      "fixture-resource-secret",
    );
  });

  it("does not exchange on a plain 403 or send its bearer to another origin", async () => {
    const { fetch, requests } = fixture();
    expect((await fetch(`${resource}/forbidden`)).status).toBe(403);
    expect((await fetch("http://127.0.0.1:40200/other")).status).toBe(200);
    expect(requests.some((request) => request.url.endsWith("/token"))).toBe(false);
    expect(requests.at(-1)?.authorization).toBeNull();
  });
});
