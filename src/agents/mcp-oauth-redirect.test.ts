import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { completeMcpOAuthAuthorization, resolveMcpOAuthAccessToken } from "./mcp-oauth.js";
import { withTempHome } from "./mcp-oauth.test-harness.js";
import { withMcpOAuthProviderForTest } from "./mcp-oauth.test-support.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const lookupMock = vi.hoisted(() => vi.fn());

class TestDispatcher {
  constructor(readonly options: unknown) {}
}

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

function installRedirectingRuntime(status: number) {
  const runtimeFetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status,
        headers: { location: "https://example.org/token" },
      }),
    )
    .mockResolvedValueOnce(new Response("ok"));
  Reflect.set(globalThis, TEST_UNDICI_RUNTIME_DEPS_KEY, {
    Agent: TestDispatcher,
    EnvHttpProxyAgent: TestDispatcher,
    ProxyAgent: TestDispatcher,
    fetch: runtimeFetchMock,
  });
  return runtimeFetchMock;
}

async function createPreparedProvider(
  params: {
    identity: ReturnType<typeof operatorMcpOAuthIdentity>;
    allowAuthorizationRedirect?: boolean;
  },
  run: Parameters<typeof withMcpOAuthProviderForTest>[1],
) {
  return await withMcpOAuthProviderForTest(params, async (provider) => {
    const authorizationServerUrl = new URL("https://example.com");
    await provider.saveClientInformation?.({ client_id: "fixture-client" });
    await provider.saveDiscoveryState?.({
      authorizationServerUrl: authorizationServerUrl.toString(),
      authorizationServerMetadata: {
        issuer: authorizationServerUrl.toString(),
        authorization_endpoint: new URL("/authorize", authorizationServerUrl).toString(),
        token_endpoint: new URL("/token", authorizationServerUrl).toString(),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      resourceMetadata: {
        resource: params.identity.serverUrl,
        authorization_servers: [authorizationServerUrl.toString()],
      },
    });
    return await run(provider);
  });
}

describe("MCP OAuth redirects", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, TEST_UNDICI_RUNTIME_DEPS_KEY);
  });

  it.each([307, 308])(
    "rejects a cross-origin code-exchange %s redirect before replaying its body",
    async (status) => {
      await withTempHome(
        async () => {
          const identity = operatorMcpOAuthIdentity(
            `Redirect ${status}`,
            "https://example.com/mcp",
          );
          await createPreparedProvider(
            { identity, allowAuthorizationRedirect: true },
            async (provider) => {
              await provider.saveCodeVerifier("synthetic-verifier");
              const authorizationUrl = new URL("https://example.com/authorize");
              authorizationUrl.searchParams.set("redirect_uri", String(provider.redirectUrl));
              authorizationUrl.searchParams.set("state", "state-1234567890");
              await provider.redirectToAuthorization(authorizationUrl);
            },
          );

          const runtimeFetchMock = installRedirectingRuntime(status);
          await expect(
            completeMcpOAuthAuthorization(
              identity,
              {
                kind: "http",
                transportType: "streamable-http",
                url: identity.serverUrl,
                auth: "oauth",
                description: identity.serverUrl,
                connectionTimeoutMs: 30_000,
                requestTimeoutMs: 60_000,
                supportsParallelToolCalls: false,
              },
              { code: "synthetic-code" },
            ),
          ).rejects.toThrow("Refusing to follow cross-origin redirect for POST request body");
          expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        },
        {
          prefix: `openclaw-mcp-oauth-cross-origin-redirect-${status}-`,
          skipSessionCleanup: true,
          env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
        },
      );
    },
  );

  it("preserves the redirect refusal through real SDK token refresh", async () => {
    await withTempHome(
      async () => {
        const identity = operatorMcpOAuthIdentity("Refresh Redirect", "https://example.com/mcp");
        await createPreparedProvider({ identity }, async (provider) => {
          await provider.saveTokens({
            access_token: "expired-access",
            refresh_token: "synthetic-refresh",
            token_type: "Bearer",
            expires_in: -1,
          });
        });
        const runtimeFetchMock = installRedirectingRuntime(307);

        await expect(resolveMcpOAuthAccessToken({ identity })).rejects.toThrow(
          "Refusing to follow cross-origin redirect for POST request body",
        );
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
      },
      {
        prefix: "openclaw-mcp-oauth-refresh-redirect-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });
});
