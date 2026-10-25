import { auth, type FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore } from "./mcp-oauth-store.js";
import { withMcpOAuthTempHome as withTempHome } from "./mcp-oauth.test-harness.js";
import { withMcpOAuthProviderForTest } from "./mcp-oauth.test-support.js";

const SERVER_URL = "https://mcp.example.com/mcp";
const ORIGINAL_METADATA_URL = "https://mcp.example.com/.well-known/oauth-protected-resource";
const REPLACEMENT_METADATA_URL = "https://metadata.example/pr-metadata";
const ORIGINAL_ISSUER = "https://auth-old.example";
const REPLACEMENT_ISSUER = "https://auth-new.example";
const STORED_ACCESS = "stored-access";
const STORED_REFRESH = "stored-refresh-secret";
const STORED_TOKENS = { access_token: STORED_ACCESS, refresh_token: STORED_REFRESH };
const IDENTITY = operatorMcpOAuthIdentity("Remote Docs", SERVER_URL);

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") {
    return body;
  }
  return body instanceof URLSearchParams ? body.toString() : "";
}

function createOAuthNetwork(
  overrides: {
    challengeMetadataUrl?: string;
    issuer?: string;
    mintedAccessToken?: string;
    registrationClientId?: string;
  } = {},
) {
  const config = {
    challengeMetadataUrl: REPLACEMENT_METADATA_URL,
    issuer: REPLACEMENT_ISSUER,
    mintedAccessToken: "attacker-access",
    ...overrides,
  };
  const tokenRequests: Array<{ url: string; body: string }> = [];
  const registrationRequests: string[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === SERVER_URL) {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${config.mintedAccessToken}`) {
        return Response.json({ ok: true });
      }
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${config.challengeMetadataUrl}"`,
        },
      });
    }
    if (url.href === new URL(config.challengeMetadataUrl).href) {
      return Response.json({ resource: SERVER_URL, authorization_servers: [config.issuer] });
    }
    if (url.href === `${config.issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}/authorize`,
        token_endpoint: `${config.issuer}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        ...(config.registrationClientId
          ? { registration_endpoint: `${config.issuer}/register` }
          : {}),
      });
    }
    if (url.href === `${config.issuer}/register` && config.registrationClientId) {
      registrationRequests.push(url.href);
      return Response.json({
        ...JSON.parse(bodyText(init?.body)),
        client_id: config.registrationClientId,
      });
    }
    if (url.href === `${config.issuer}/token`) {
      tokenRequests.push({ url: url.href, body: bodyText(init?.body) });
      return Response.json({
        access_token: config.mintedAccessToken,
        refresh_token: "rotated-refresh-secret",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return new Response(null, { status: 404 });
  };
  return { fetchFn, tokenRequests, registrationRequests };
}

async function seedAuthorizedStore(
  order: "discovery-then-tokens" | "tokens-then-discovery",
  expiresIn = 3600,
) {
  await withMcpOAuthProviderForTest({ identity: IDENTITY }, async (provider) => {
    const discoveryState = {
      authorizationServerUrl: ORIGINAL_ISSUER,
      resourceMetadataUrl: ORIGINAL_METADATA_URL,
    };
    const tokens = {
      ...STORED_TOKENS,
      token_type: "Bearer",
      expires_in: expiresIn,
    };
    await provider.saveClientInformation?.({ client_id: "stored-client-id" });
    if (order === "discovery-then-tokens") {
      await provider.saveDiscoveryState?.(discoveryState);
      await provider.saveTokens(tokens);
    } else {
      await provider.saveTokens(tokens);
      await provider.saveDiscoveryState?.(discoveryState);
    }
  });
}

function originalNetwork() {
  return createOAuthNetwork({
    challengeMetadataUrl: ORIGINAL_METADATA_URL,
    issuer: ORIGINAL_ISSUER,
    mintedAccessToken: "rotated-access",
  });
}

function request({ fetchFn }: ReturnType<typeof createOAuthNetwork>) {
  return withMcpOAuthBearer({ fetchFn, authFetchFn: fetchFn, identity: IDENTITY })(SERVER_URL, {
    method: "POST",
    body: "{}",
  });
}

function readStore() {
  return readMcpOAuthStore(IDENTITY.storeKey);
}

describe("MCP OAuth refresh issuer binding", () => {
  it.each(["discovery-then-tokens", "tokens-then-discovery"] as const)(
    "binds issuer provenance and blocks rediscovery to another issuer (%s)",
    async (order) => {
      await withTempHome(async () => {
        await seedAuthorizedStore(order);
        expect((await readStore()).tokensAuthorizationServerUrl).toBe(
          order === "tokens-then-discovery" ? undefined : ORIGINAL_ISSUER,
        );
        const network = createOAuthNetwork();
        await expect(request(network)).rejects.toThrow(/requires OAuth authorization/);
        expect(network.tokenRequests).toEqual([]);
        expect((await readStore()).tokens).toMatchObject(STORED_TOKENS);
        expect((await readStore()).tokensAuthorizationServerUrl).toBe(ORIGINAL_ISSUER);
        if (order === "tokens-then-discovery") {
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
          expect((await readStore()).tokensAuthorizationServerUrl).toBe(ORIGINAL_ISSUER);
        }
      }, "openclaw-mcp-oauth-issuer-switch-");
    },
  );
  it("still refreshes when a new metadata URL resolves to the original issuer", async () => {
    await withTempHome(async () => {
      await seedAuthorizedStore("discovery-then-tokens");
      const network = createOAuthNetwork({
        challengeMetadataUrl: REPLACEMENT_METADATA_URL,
        issuer: ORIGINAL_ISSUER,
        mintedAccessToken: "rotated-access",
      });

      const response = await request(network);

      expect(response.status).toBe(200);
      expect(network.tokenRequests).toHaveLength(1);
      expect(network.tokenRequests[0]?.url).toBe(`${ORIGINAL_ISSUER}/token`);
      expect(network.tokenRequests[0]?.body).toContain(`refresh_token=${STORED_REFRESH}`);
      expect((await readStore()).tokens?.access_token).toBe("rotated-access");
    }, "openclaw-mcp-oauth-issuer-same-");
  });

  it.each([
    ["an explicit default port", "https://auth-old.example:443"],
    ["different host casing", "https://AUTH-OLD.example"],
    ["a trailing slash", "https://auth-old.example/"],
  ])(
    "does not disclose a refresh token when the issuer differs by %s",
    async (_variant, issuer) => {
      await withTempHome(async () => {
        await seedAuthorizedStore("discovery-then-tokens");
        await withMcpOAuthProviderForTest({ identity: IDENTITY }, async (provider) => {
          await provider.saveDiscoveryState?.({
            authorizationServerUrl: issuer,
            resourceMetadataUrl: REPLACEMENT_METADATA_URL,
          });

          expect(await provider.tokens()).toBeUndefined();
        });
        expect((await readStore()).tokens).toMatchObject(STORED_TOKENS);
      }, "openclaw-mcp-oauth-issuer-normalization-");
    },
  );

  it("refreshes an upgraded row whose issuer is recoverable from stored discovery", async () => {
    await withTempHome(async () => {
      await seedAuthorizedStore("tokens-then-discovery", 0);
      expect((await readStore()).tokensAuthorizationServerUrl).toBeUndefined();
      expect((await readStore()).discoveryState?.authorizationServerUrl).toBe(ORIGINAL_ISSUER);
      const network = originalNetwork();

      const response = await request(network);

      expect(response.status).toBe(200);
      expect(network.tokenRequests).toHaveLength(1);
      expect(network.tokenRequests[0]?.url).toBe(`${ORIGINAL_ISSUER}/token`);
      expect(network.tokenRequests[0]?.body).toContain(`refresh_token=${STORED_REFRESH}`);
      expect((await readStore()).tokensAuthorizationServerUrl).toBe(ORIGINAL_ISSUER);
    }, "openclaw-mcp-oauth-issuer-upgrade-");
  });

  it.each([undefined, "replacement-client-id"])(
    "blocks an issuer-changing challenge after refresh (registration client: %s)",
    async (registrationClientId) => {
      await withTempHome(async () => {
        await seedAuthorizedStore("tokens-then-discovery", 0);
        const sameIssuer = originalNetwork();
        await request(sameIssuer);
        const refreshedStore = await readStore();
        expect(refreshedStore.tokens).toMatchObject({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh-secret",
          issuer: ORIGINAL_ISSUER,
        });
        expect(refreshedStore.clientInformation).toMatchObject({
          client_id: "stored-client-id",
          issuer: ORIGINAL_ISSUER,
        });

        const newIssuer = createOAuthNetwork({ registrationClientId });
        await expect(request(newIssuer)).rejects.toThrow(/requires OAuth authorization/);

        expect(newIssuer.tokenRequests).toEqual([]);
        expect(newIssuer.registrationRequests).toEqual([]);
        const retainedStore = await readStore();
        expect(retainedStore.tokens).toEqual(refreshedStore.tokens);
        expect(retainedStore.clientInformation).toEqual(refreshedStore.clientInformation);
        expect(retainedStore.tokensAuthorizationServerUrl).toBe(ORIGINAL_ISSUER);
      }, "openclaw-mcp-oauth-issuer-upgrade-challenge-");
    },
  );

  it("allows explicit login to register with the replacement issuer", async () => {
    await withTempHome(async () => {
      await seedAuthorizedStore("tokens-then-discovery", 0);
      const original = originalNetwork();
      await request(original);
      const replacement = createOAuthNetwork({
        challengeMetadataUrl: REPLACEMENT_METADATA_URL,
        issuer: REPLACEMENT_ISSUER,
        mintedAccessToken: "replacement-access",
        registrationClientId: "replacement-client-id",
      });
      await expect(request(replacement)).rejects.toThrow(/requires OAuth authorization/);

      await withMcpOAuthProviderForTest(
        { identity: IDENTITY, allowAuthorizationRedirect: true },
        async (provider) => {
          expect(
            await auth(provider, {
              serverUrl: SERVER_URL,
              resourceMetadataUrl: new URL(REPLACEMENT_METADATA_URL),
              fetchFn: replacement.fetchFn,
            }),
          ).toBe("REDIRECT");
        },
      );
      expect(replacement.registrationRequests).toEqual([`${REPLACEMENT_ISSUER}/register`]);
      expect(replacement.tokenRequests).toEqual([]);
      expect((await readStore()).clientInformation).toMatchObject({
        client_id: "replacement-client-id",
        issuer: REPLACEMENT_ISSUER,
      });
    }, "openclaw-mcp-oauth-issuer-explicit-login-");
  });

  it("fails closed for a token-only legacy store with no recoverable issuer", async () => {
    await withTempHome(async () => {
      await withMcpOAuthProviderForTest({ identity: IDENTITY }, async (provider) => {
        await provider.saveClientInformation?.({ client_id: "stored-client-id" });
        await provider.saveTokens({
          access_token: STORED_ACCESS,
          refresh_token: STORED_REFRESH,
          token_type: "Bearer",
          expires_in: 3600,
        });
      });
      expect((await readStore()).discoveryState).toBeUndefined();
      expect((await readStore()).tokensAuthorizationServerUrl).toBeUndefined();
      const network = createOAuthNetwork();

      await expect(request(network)).rejects.toThrow(/OAuth authorization/);

      expect(network.tokenRequests).toEqual([]);
      expect((await readStore()).tokens).toMatchObject({ refresh_token: STORED_REFRESH });
    }, "openclaw-mcp-oauth-issuer-tokenonly-");
  });
});
