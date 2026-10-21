import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { mcpEnterpriseIdpStoreKey, type McpEnterpriseConfig } from "./mcp-enterprise.js";
import { clearMcpOAuthStore, mutateMcpOAuthStore } from "./mcp-oauth-store.js";
import { seedMcpOAuthStoreForTest, withMcpOAuthTestLease } from "./mcp-oauth.test-support.js";
import { resolveMcpTransport } from "./mcp-transport.js";

const { lookupMock, runtimeFetchMock, streamableTransportMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  runtimeFetchMock: vi.fn(),
  streamableTransportMock: vi.fn(),
}));

// Keep the production enterprise owner and guarded HTTP path; replace only DNS,
// the final network effect, and the SDK transport container.
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
// mock-isolation: Observe the guarded fetch's final effect without contacting fixture domains.
vi.mock("../infra/net/undici-runtime.js", () => ({
  createHttp1Agent: (options: unknown) => ({ options }),
  createHttp1EnvHttpProxyAgent: (options: unknown) => ({ options }),
  createHttp1ProxyAgent: (options: unknown) => ({ options }),
  loadUndiciRuntimeDeps: () => ({ fetch: runtimeFetchMock }),
}));
// mock-isolation: Capture the SDK transport's configured fetch without opening a network connection.
vi.mock("./mcp-http-transport.js", () => ({
  OpenClawStreamableHTTPClientTransport: streamableTransportMock,
}));

const resource = "https://mcp.example.com/mcp";
const idp = "https://idp.example.com";
const authorizationServer = "https://auth.example.com";
const enterprise: McpEnterpriseConfig = {
  identity: "shared",
  idpIssuer: idp,
  idpClientId: "fixture-idp-client",
  idpClientSecret: "fixture-idp-secret",
  resourceIssuer: authorizationServer,
  resourceClientId: "fixture-resource-client",
  resourceClientSecret: "fixture-resource-secret",
  scope: "mcp.read",
  redirectUrl: "http://localhost:3097/callback",
};

it.each(["unchanged", "logout", "replacement"] as const)(
  "guards the complete enterprise retry at final HTTP dispatch during %s",
  async (change) => {
    await withOpenClawTestState({ label: `enterprise-guarded-${change}` }, async () => {
      const storeKey = mcpEnterpriseIdpStoreKey(enterprise);
      const seed = (authorizationId: string) =>
        seedMcpOAuthStoreForTest(storeKey, {
          authorizationId,
          tokens: {
            access_token: "fixture-idp-access",
            id_token: "fixture-id-token",
            token_type: "Bearer",
          },
          tokenExpiresAt: Date.now() + 300_000,
        });
      seed("first-account");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const requests: Array<{ url: string; bearer: string | null }> = [];
      let redeemed = false;
      let paused = false;
      lookupMock.mockReset().mockImplementation(async (hostname: string) => {
        if (hostname === "mcp.example.com" && redeemed && !paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return [{ address: "93.184.216.34", family: 4 }];
      });
      runtimeFetchMock.mockReset().mockImplementation(async (input: string, init?: RequestInit) => {
        const url = input;
        const bearer = new Headers(init?.headers).get("authorization");
        requests.push({ url, bearer });
        if (url === resource) {
          return bearer === "Bearer fixture-resource-token"
            ? Response.json({ ok: true })
            : new Response(null, {
                status: 401,
                headers: { "www-authenticate": `Bearer resource_metadata="${resource}/metadata"` },
              });
        }
        if (url === `${resource}/metadata`) {
          return Response.json({ resource, authorization_servers: [authorizationServer] });
        }
        if (url === `${authorizationServer}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: authorizationServer,
            token_endpoint: `${authorizationServer}/token`,
            authorization_endpoint: `${authorizationServer}/authorize`,
            response_types_supported: ["code"],
            authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"],
          });
        }
        if (url === `${idp}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: idp,
            token_endpoint: `${idp}/token`,
            authorization_endpoint: `${idp}/authorize`,
            response_types_supported: ["code"],
          });
        }
        if (url === `${idp}/token`) {
          return Response.json({
            access_token: "fixture-id-jag",
            issued_token_type: "urn:ietf:params:oauth:token-type:id-jag",
            token_type: "N_A",
            expires_in: 300,
          });
        }
        if (url === `${authorizationServer}/token`) {
          redeemed = true;
          return Response.json({
            access_token: "fixture-resource-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        throw new Error(`Unexpected fixture request: ${url}`);
      });
      streamableTransportMock.mockClear();
      expect(
        resolveMcpTransport("probe", {
          url: resource,
          transport: "streamable-http",
          auth: "enterprise",
          enterprise,
        }),
      ).not.toBeNull();
      const fetch = streamableTransportMock.mock.calls.at(-1)?.[1]?.fetch as
        | ((input: string) => Promise<Response>)
        | undefined;
      expect(fetch).toBeTypeOf("function");
      const first = fetch!(resource);
      await awaitGateBeforeSettlement(
        entered.promise,
        first,
        "Enterprise request settled before guarded DNS preparation",
      );
      expect(requests.filter((request) => request.url === resource)).toHaveLength(1);
      expect(requests.some((request) => request.url === `${idp}/token`)).toBe(true);
      expect(requests.some((request) => request.url === `${authorizationServer}/token`)).toBe(true);
      const sentBeforeRelease = requests.length;
      if (change === "logout") {
        await withMcpOAuthTestLease(storeKey, (lease, context) =>
          clearMcpOAuthStore({ storeKey, lease, context }),
        );
      } else if (change === "replacement") {
        await withMcpOAuthTestLease(storeKey, (lease, context) =>
          mutateMcpOAuthStore(
            { storeKey, lease, context },
            {
              kind: "tokens",
              tokens: {
                access_token: "fixture-idp-access",
                id_token: "fixture-id-token",
                token_type: "Bearer",
              },
              tokenExpiresAt: Date.now() + 300_000,
              replaceAuthorization: true,
            },
          ),
        );
      }
      release.resolve();
      if (change === "unchanged") {
        expect((await first).status).toBe(200);
        expect(requests).toHaveLength(sentBeforeRelease + 1);
        expect(requests.filter((request) => request.url === resource)).toHaveLength(2);
        return;
      }
      await expect(first).rejects.toThrow(/expired|changed|disconnected|replaced/i);
      expect(requests).toHaveLength(sentBeforeRelease);
      expect(requests.filter((request) => request.url === resource)).toHaveLength(1);
      if (change === "logout") {
        seed("second-account");
      }
      expect((await fetch!(resource)).status).toBe(200);
      expect(requests.filter((request) => request.url === resource)).toHaveLength(3);
    });
  },
);
