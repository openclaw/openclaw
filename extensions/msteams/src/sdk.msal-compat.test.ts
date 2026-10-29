import { createRequire } from "node:module";
import { ClientSecretCredential } from "@azure/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";

const require = createRequire(import.meta.url);
const tenant = "11111111-1111-1111-1111-111111111111";
const clientId = "22222222-2222-2222-2222-222222222222";
const authority = "https://login.microsoftonline.com/" + tenant;
const metadata = {
  issuer: authority + "/v2.0",
  authorization_endpoint: authority + "/oauth2/v2.0/authorize",
  token_endpoint: authority + "/oauth2/v2.0/token",
  jwks_uri: authority + "/discovery/v2.0/keys",
  end_session_endpoint: authority + "/oauth2/v2.0/logout",
};
const token = [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify({ appid: clientId, tid: tenant, exp: 4102444800 })).toString(
    "base64url",
  ),
  "fixture",
].join(".");
function reply(url: string) {
  expect(new URL(url).hostname).toBe("login.microsoftonline.com");
  if (url.includes("openid-configuration")) {
    return metadata;
  }
  if (url.includes("/discovery/instance")) {
    return {
      tenant_discovery_endpoint: authority + "/v2.0/.well-known/openid-configuration",
      metadata: [
        {
          preferred_network: "login.microsoftonline.com",
          preferred_cache: "login.microsoftonline.com",
          aliases: ["login.microsoftonline.com"],
        },
      ],
    };
  }
  expect(new URL(url).origin + new URL(url).pathname).toBe(metadata.token_endpoint);
  return { token_type: "Bearer", access_token: token, expires_in: 3600 };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scoped MSAL 7 compatibility", () => {
  it("acquires a Teams app token through the real SDK and MSAL", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return Response.json(reply(url));
      }),
    );
    const { app } = await loadMSTeamsSdkWithAuth({
      type: "secret",
      appId: clientId,
      appPassword: "fixture-secret",
      tenantId: tenant,
    });
    const result = await app.tokenProvider.getAppToken("https://graph.microsoft.com/.default");
    expect(String(result)).toBe(token);
    const grant = new URLSearchParams(
      requests.find((r) => r.url.startsWith(metadata.token_endpoint))!.body,
    );
    expect(grant.get("grant_type")).toBe("client_credentials");
    expect(grant.get("client_id")).toBe(clientId);
    expect(grant.get("client_secret")).toBe("fixture-secret");
  });

  it("acquires an Azure Identity token through its actual HTTP adapter", async () => {
    const azureRequire = createRequire(require.resolve("@azure/identity"));
    const { createHttpHeaders } = azureRequire("@azure/core-rest-pipeline");
    const requests: string[] = [];
    const credential = new ClientSecretCredential(tenant, clientId, "fixture-secret", {
      disableInstanceDiscovery: true,
      httpClient: {
        async sendRequest(request) {
          requests.push(request.url);
          return {
            request,
            status: 200,
            headers: createHttpHeaders(),
            bodyAsText: JSON.stringify(reply(request.url)),
          };
        },
      },
    });
    const result = await credential.getToken("https://graph.microsoft.com/.default");
    expect(result.token).toBe(token);
    expect(requests.some((url) => url.startsWith(metadata.token_endpoint))).toBe(true);
  });

  it.each(["@microsoft/teams.apps", "@azure/identity"])(
    "ignores attacker-controlled authorization response routing under %s",
    async (parent) => {
      const parentRequire = createRequire(require.resolve(parent));
      const { ConfidentialClientApplication } = parentRequire("@azure/msal-node");
      const requests: string[] = [];
      const client = new ConfidentialClientApplication({
        auth: {
          clientId,
          clientSecret: "fixture-secret",
          authority,
          knownAuthorities: ["login.microsoftonline.com"],
          authorityMetadata: JSON.stringify(metadata),
        },
        system: {
          networkClient: {
            async sendGetRequestAsync(url: string) {
              requests.push(url);
              return { status: 200, headers: {}, body: reply(url) };
            },
            async sendPostRequestAsync(url: string) {
              requests.push(url);
              return { status: 200, headers: {}, body: reply(url) };
            },
          },
        },
      });
      const result = await client.acquireTokenByCode(
        {
          code: "fixture-code",
          scopes: ["https://graph.microsoft.com/.default"],
          redirectUri: "http://localhost/callback",
        },
        {
          code: "fixture-code",
          cloud_instance_host_name: "attacker.invalid",
          cloud_instance_name: "attacker.invalid",
        },
      );
      expect(result.accessToken).toBe(token);
      expect(requests.map((url) => new URL(url).origin + new URL(url).pathname)).toEqual([
        metadata.token_endpoint,
      ]);
    },
  );
});
