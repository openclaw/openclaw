import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config/types.mcp.js";
import { handleMcpOAuthCallback } from "../gateway/mcp-oauth-callback.js";
import { createRequest, createResponse } from "../gateway/server-http.test-harness.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import {
  readMcpOAuthPendingAuthorization as readPending,
  readMcpOAuthStore,
} from "./mcp-oauth-store.js";
import {
  completeMcpOAuthAuthorization,
  countMcpOAuthPrincipals,
  readMcpOAuthCredentialsStatus,
  recordMcpOAuthAuthorizationRequired,
  resolveMcpOAuthAccessToken,
  startMcpOAuthAuthorization,
} from "./mcp-oauth.js";
import { requesterIdentity, withTempHome as withBaseTempHome } from "./mcp-oauth.test-harness.js";
import {
  resolvedOAuthConfig,
  seedMcpOAuthStoreForTest,
  withMcpOAuthProviderForTest,
} from "./mcp-oauth.test-support.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

const authMock = vi.hoisted(() => vi.fn());
const ROTATED_ACCESS = "gateway-token";
const REMOTE_IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");
const CALENDLY_IDENTITY = operatorMcpOAuthIdentity("Calendly", "https://mcp.calendly.com/");
const metadataUrl = () => new URL("https://mcp.example.com/.well-known/oauth-protected-resource");
const readStore = () => readMcpOAuthStore(REMOTE_IDENTITY.storeKey);

const startAuthorization = () =>
  startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {});

const completeAuthorization = (code: string) =>
  completeMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), { code });

async function runGatewayOAuthCallback(params: {
  serverName: string;
  server: McpServerConfig;
  code: string;
  state: string;
}) {
  const response = createResponse();
  await handleMcpOAuthCallback(
    createRequest({
      path: `/oauth/mcp/callback?code=${params.code}&state=${params.state}`,
    }),
    response.res,
    {
      config: { mcp: { servers: { [params.serverName]: params.server } } },
      log: { warn: vi.fn() },
    },
  );
  return response;
}

async function persistRedirect(provider: OAuthClientProvider) {
  await provider.saveCodeVerifier("verifier");
  const authorizationUrl = new URL("https://auth.example.com/authorize");
  authorizationUrl.searchParams.set("redirect_uri", String(provider.redirectUrl));
  authorizationUrl.searchParams.set("state", "state-1234567890");
  await provider.redirectToAuthorization(authorizationUrl);
  return "REDIRECT" as const;
}

function sendOAuthJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readOAuthBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startAuthorizationServer() {
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      sendOAuthJson(response, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendOAuthJson(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const metadata = JSON.parse(await readOAuthBody(request)) as Record<string, unknown>;
      sendOAuthJson(response, { ...metadata, client_id: "fixture-client" }, 201);
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readOAuthBody(request));
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (form.get("code") !== challenge) {
        sendOAuthJson(response, { error: "invalid_grant" }, 400);
        return;
      }
      sendOAuthJson(response, {
        access_token: `access-${challenge.slice(0, 8)}`,
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    response.writeHead(404).end();
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("OAuth fixture failed"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function authorizationCode(authorizationUrl: string): string {
  const code = new URL(authorizationUrl).searchParams.get("code_challenge");
  assert(code, "authorization URL omitted the PKCE challenge");
  return code;
}

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/client")>()),
  auth: authMock,
}));

function withTempHome<T>(run: (home: string) => T | Promise<T>, prefix: string) {
  return withBaseTempHome(run, {
    prefix,
    skipSessionCleanup: true,
    env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
  });
}

function makeTokens(access_token: string, refresh_token: string, expires_in = 3600) {
  return { access_token, refresh_token, token_type: "Bearer", expires_in };
}

async function authorize(provider: OAuthClientProvider) {
  await provider.saveTokens(makeTokens("gateway-token", "secret-token"));
  return "AUTHORIZED";
}

function withProvider<T>(run: (provider: OAuthClientProvider) => Promise<T>) {
  return withMcpOAuthProviderForTest({ identity: REMOTE_IDENTITY }, run);
}

function saveTokens(tokens: Parameters<OAuthClientProvider["saveTokens"]>[0]) {
  return withProvider(async (provider) => await provider.saveTokens(tokens));
}

describe("MCP OAuth provider", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("reuses a valid stored session without persisting an authorization redirect", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("stored-access", "stored-refresh"));
      const before = await readStore();
      authMock.mockImplementationOnce(async (loginProvider) =>
        (await loginProvider.tokens()) ? "AUTHORIZED" : await persistRedirect(loginProvider),
      );

      await expect(startAuthorization()).resolves.toEqual({ status: "authorized" });
      expect(await readStore()).toEqual(before);
    }, "openclaw-mcp-oauth-existing-session-");
  });

  it("preserves insufficient scope and forces the next login through authorization", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("decoy-token", "test-auth-token"));

      await expect(
        resolveMcpOAuthAccessToken({
          identity: REMOTE_IDENTITY,
          authorizationChallenge: true,
          interactiveAuthorizationRequired: true,
          rejectedAccessToken: "decoy-token",
          scope: "docs.write",
        }),
      ).rejects.toThrow(
        'MCP server "Remote Docs" requires additional OAuth authorization. Run openclaw mcp login Remote Docs.',
      );
      expect(authMock).not.toHaveBeenCalled();
      expect(await withProvider(async (provider) => await provider.tokens())).toMatchObject({
        access_token: "decoy-token",
        refresh_token: "test-auth-token",
      });
      expect((await readStore()).pendingAuthorizationChallenge).toEqual({
        requiresAuthorization: true,
        scope: "docs.write",
      });
      await expect(readMcpOAuthCredentialsStatus(REMOTE_IDENTITY)).resolves.toMatchObject({
        state: "requires-authorization",
      });

      const storeKey = REMOTE_IDENTITY.storeKey;
      seedMcpOAuthStoreForTest(storeKey, {
        ...(await readMcpOAuthStore(storeKey)),
        tokenExpiresAt: 0,
      });
      await expect(resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY })).rejects.toThrow(
        "requires additional OAuth authorization",
      );
      expect(authMock).not.toHaveBeenCalled();
      expect(await readMcpOAuthStore(storeKey)).toMatchObject({
        tokens: { access_token: "decoy-token" },
        tokenExpiresAt: 0,
        pendingAuthorizationChallenge: { requiresAuthorization: true, scope: "docs.write" },
      });

      authMock.mockImplementationOnce(async (loginProvider, options) => {
        expect(await loginProvider.tokens()).toBeUndefined();
        expect(options.scope).toBe("docs.write");
        return await persistRedirect(loginProvider);
      });
      await expect(startAuthorization()).resolves.toMatchObject({
        status: "redirect",
        state: "state-1234567890",
      });
      expect(await withProvider(async (provider) => await provider.tokens())).toMatchObject({
        access_token: "decoy-token",
      });

      authMock.mockImplementationOnce(async (loginProvider) => {
        await loginProvider.invalidateCredentials?.("tokens");
        throw new Error("replacement authorization failed");
      });
      await expect(completeAuthorization("expired-code")).rejects.toThrow(
        "replacement authorization failed",
      );
      expect(await readMcpOAuthStore(storeKey)).toMatchObject({
        tokens: { access_token: "decoy-token" },
        tokenExpiresAt: 0,
        pendingAuthorizationChallenge: { requiresAuthorization: true },
      });

      authMock.mockImplementationOnce(authorize);
      await expect(completeAuthorization("valid-code")).resolves.toBe("authorized");
      expect(await readMcpOAuthStore(storeKey)).toMatchObject({
        tokens: { access_token: ROTATED_ACCESS },
      });
      expect((await readMcpOAuthStore(storeKey)).pendingAuthorizationChallenge).toBeUndefined();
    }, "openclaw-mcp-oauth-insufficient-scope-");
  });

  it("stops refreshing after a replacement token is rejected twice", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("replacement-token", "replacement-refresh"));

      await expect(
        recordMcpOAuthAuthorizationRequired({
          identity: REMOTE_IDENTITY,
          rejectedAccessToken: "replacement-token",
          scope: "docs.read",
        }),
      ).resolves.toBe(true);
      await expect(resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY })).rejects.toThrow(
        "requires additional OAuth authorization",
      );
      expect(authMock).not.toHaveBeenCalled();
      expect(await withProvider(async (provider) => await provider.tokens())).toMatchObject({
        access_token: "replacement-token",
      });

      await saveTokens(makeTokens("newer-token", "newer-refresh"));
      await expect(
        recordMcpOAuthAuthorizationRequired({
          identity: REMOTE_IDENTITY,
          rejectedAccessToken: "replacement-token",
        }),
      ).resolves.toBe(false);
      expect(await withProvider(async (provider) => await provider.tokens())).toMatchObject({
        access_token: "newer-token",
      });
    }, "openclaw-mcp-oauth-terminal-rejection-");
  });

  it("keeps a rejected-token challenge for explicit reauthorization after refresh fails", async () => {
    await withTempHome(async () => {
      await withProvider(async (provider) => {
        await provider.saveTokens(makeTokens("decoy-token", "test-auth-token"));
        await provider.saveDiscoveryState?.({
          authorizationServerUrl: "https://old-auth.example.com",
          resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/old",
        });
      });
      const resourceMetadataUrl = metadataUrl();
      authMock.mockRejectedValueOnce(new Error("scope refresh rejected"));

      await expect(
        resolveMcpOAuthAccessToken({
          identity: REMOTE_IDENTITY,
          authorizationChallenge: true,
          rejectedAccessToken: "decoy-token",
          resourceMetadataUrl,
          scope: "docs.write",
        }),
      ).rejects.toThrow("scope refresh rejected");
      expect(await readStore()).toMatchObject({
        pendingAuthorizationChallenge: {
          resourceMetadataUrl: resourceMetadataUrl.toString(),
          scope: "docs.write",
        },
      });
      expect((await readStore()).discoveryState).toBeUndefined();

      authMock.mockImplementationOnce(persistRedirect);
      await expect(startAuthorization()).resolves.toMatchObject({ state: "state-1234567890" });
      expect(authMock.mock.calls[1]?.[1]).toMatchObject({
        resourceMetadataUrl,
        scope: "docs.write",
      });
    }, "openclaw-mcp-oauth-rejected-token-challenge-");
  });

  it("uses a persisted challenge when refreshing after Doctor credential import", async () => {
    await withTempHome(async () => {
      const storeKey = REMOTE_IDENTITY.storeKey;
      const resourceMetadataUrl = metadataUrl();
      await saveTokens(makeTokens("legacy-access", "legacy-refresh"));
      seedMcpOAuthStoreForTest(storeKey, {
        ...(await readMcpOAuthStore(storeKey)),
        tokenExpiresAt: 0,
        pendingAuthorizationChallenge: {
          resourceMetadataUrl: resourceMetadataUrl.toString(),
          scope: "docs.read",
        },
      });
      authMock.mockImplementationOnce(async (refreshProvider, options) => {
        expect(options).toMatchObject({ resourceMetadataUrl, scope: "docs.read" });
        await refreshProvider.saveTokens(makeTokens("gateway-token", "secret-token"));
        return "AUTHORIZED";
      });

      await expect(resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY })).resolves.toBe(
        ROTATED_ACCESS,
      );
      expect((await readMcpOAuthStore(storeKey)).pendingAuthorizationChallenge).toBeUndefined();
    }, "openclaw-mcp-oauth-doctor-challenge-");
  });

  it("uses unknown-expiry tokens live but refreshes them before blind projection", async () => {
    await withTempHome(async () => {
      await saveTokens(makeTokens("example", "test-auth-token"));
      const storeKey = REMOTE_IDENTITY.storeKey;
      const legacyStore = await readMcpOAuthStore(storeKey);
      delete legacyStore.tokenExpiresAt;
      seedMcpOAuthStoreForTest(storeKey, legacyStore);

      await expect(
        resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY, acceptUnknownExpiry: true }),
      ).resolves.toBe("example");
      expect(authMock).not.toHaveBeenCalled();

      authMock.mockImplementationOnce(authorize);

      await expect(resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY })).resolves.toBe(
        ROTATED_ACCESS,
      );
      expect(authMock).toHaveBeenCalledOnce();
    }, "openclaw-mcp-oauth-legacy-token-");
  });

  it("persists challenge hints without mutating an in-flight PKCE login", async () => {
    await withTempHome(async () => {
      const resourceMetadataUrl = metadataUrl();
      await withMcpOAuthProviderForTest(
        { identity: REMOTE_IDENTITY, allowAuthorizationRedirect: true },
        async (provider) => {
          await provider.saveCodeVerifier("existing-verifier");
          expect(await provider.codeVerifier()).toBe("existing-verifier");
          await provider.redirectToAuthorization(
            new URL("https://auth.example.com/authorize?state=existing-state"),
          );
        },
      );

      await expect(
        resolveMcpOAuthAccessToken({
          identity: REMOTE_IDENTITY,
          authorizationChallenge: true,
          resourceMetadataUrl,
          scope: "docs.read",
        }),
      ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
      expect(authMock).not.toHaveBeenCalled();
      expect(await readStore()).toMatchObject({
        codeVerifier: "existing-verifier",
        pendingAuthorizationChallenge: {
          resourceMetadataUrl: resourceMetadataUrl.toString(),
          scope: "docs.read",
        },
      });

      authMock.mockImplementationOnce(persistRedirect);
      await expect(startAuthorization()).resolves.toMatchObject({ state: "state-1234567890" });
      expect(authMock.mock.calls[0]?.[1]).toMatchObject({
        resourceMetadataUrl,
        scope: "docs.read",
      });
    }, "openclaw-mcp-oauth-challenge-bootstrap-");
  });

  it("stores token state only in shared SQLite with restricted permissions", async () => {
    await withTempHome(async (home) => {
      await withProvider(async (provider) => {
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });

        expect(await provider.tokens()).toEqual({ access_token: "access", token_type: "Bearer" });
      });

      const databasePath = resolveOpenClawStateSqlitePath();
      const rows = openOpenClawStateDatabase()
        .db.prepare("SELECT store_key, format_version FROM mcp_oauth_stores")
        .all();
      expect(rows).toEqual([
        { store_key: expect.stringMatching(/^Remote-Docs-[a-f0-9]{16}$/), format_version: 1 },
      ]);
      await expect(fs.readdir(`${home}/.openclaw/mcp-oauth`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const stat = await fs.stat(databasePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }, "openclaw-mcp-oauth-");
  });

  it("does not create shared state for a read-only credential status check", async () => {
    await withTempHome(async () => {
      await expect(readMcpOAuthCredentialsStatus(REMOTE_IDENTITY)).resolves.toEqual({
        state: "unauthenticated",
      });
      expect(await countMcpOAuthPrincipals(REMOTE_IDENTITY)).toBe(0);
      await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
        code: "ENOENT",
      });
      const database = openOpenClawStateDatabase().db;
      database.exec("DROP TABLE mcp_oauth_stores");
      expect(await countMcpOAuthPrincipals(REMOTE_IDENTITY)).toBe(0);
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get("mcp_oauth_stores"),
      ).toBeUndefined();
    }, "openclaw-mcp-oauth-status-");
  });

  it("fails closed when canonical token expiry has no token state", async () => {
    await withTempHome(async () => {
      await withProvider(async (provider) => {
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });
        const storeKey = REMOTE_IDENTITY.storeKey;
        openOpenClawStateDatabase()
          .db.prepare("UPDATE mcp_oauth_stores SET store_json = ? WHERE store_key = ?")
          .run(JSON.stringify({ tokenExpiresAt: 10_000 }), storeKey);

        await expect(provider.tokens()).rejects.toThrow("tokenExpiresAt requires tokens");
      });
    }, "openclaw-mcp-oauth-orphan-expiry-");
  });

  it("persists the localhost retry for completion and then clears the session", async () => {
    await withTempHome(async () => {
      authMock
        .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
        .mockImplementationOnce(persistRedirect);

      const session = await startMcpOAuthAuthorization(
        CALENDLY_IDENTITY,
        resolvedOAuthConfig(CALENDLY_IDENTITY),
        {},
      );
      assert(session.status === "redirect", "expected MCP OAuth redirect");

      expect(session.redirectUrl).toBe("http://localhost:8989/oauth/callback");
      expect(authMock.mock.calls[1]?.[0]?.clientMetadata.redirect_uris).toEqual([
        "http://localhost:8989/oauth/callback",
      ]);
      expect(await readMcpOAuthStore(CALENDLY_IDENTITY.storeKey)).toMatchObject({
        codeVerifier: "verifier",
        redirectUrl: "http://localhost:8989/oauth/callback",
      });

      authMock.mockReset();
      authMock.mockImplementationOnce(async (provider, options) => {
        expect(options.authorizationCode).toBe("code-123");
        expect(provider.redirectUrl).toBe("http://localhost:8989/oauth/callback");
        expect(await provider.codeVerifier()).toBe("verifier");
        return "AUTHORIZED";
      });
      await expect(
        completeMcpOAuthAuthorization(CALENDLY_IDENTITY, resolvedOAuthConfig(CALENDLY_IDENTITY), {
          code: "code-123",
        }),
      ).resolves.toBe("authorized");
      expect(await readMcpOAuthStore(CALENDLY_IDENTITY.storeKey)).not.toMatchObject({
        codeVerifier: expect.anything(),
        redirectUrl: expect.anything(),
      });
    }, "openclaw-mcp-oauth-localhost-persist-");
  });

  it("does not start hidden authorization flows without an authorization callback", async () => {
    await withTempHome(async () => {
      await withProvider(async (provider) => {
        await expect(provider.state?.()).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        expect(() => provider.saveCodeVerifier?.("verifier")).toThrow(
          "Run openclaw mcp login Remote Docs.",
        );
        await expect(
          provider.redirectToAuthorization?.(new URL("https://auth.example.com/authorize")),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
      });
    }, "openclaw-mcp-oauth-noninteractive-");
  });

  it("resumes authorization after restart, retains failures, and supersedes older starts", async () => {
    await withTempHome(async () => {
      const { auth: realAuth } = await vi.importActual<
        typeof import("@modelcontextprotocol/client")
      >("@modelcontextprotocol/client");
      authMock.mockImplementation(realAuth);
      const fixture = await startAuthorizationServer();
      const rawServer = {
        url: `${fixture.issuer}/mcp`,
        transport: "streamable-http" as const,
        auth: "oauth" as const,
        oauth: {
          identity: "per-requester" as const,
          redirectUrl: "https://gateway.example.com/oauth/mcp/callback",
        },
      };
      const config = resolveMcpTransportConfig("fixture", rawServer);
      assert(config?.kind === "http", "expected HTTP MCP OAuth config");
      const identity = requesterIdentity("fixture", config.url, "sender-a");
      try {
        const first = await startMcpOAuthAuthorization(identity, config, {});
        assert(first.status === "redirect", "expected first MCP OAuth redirect");
        expect(await readMcpOAuthStore(identity.storeKey)).toMatchObject({
          codeVerifier: expect.any(String),
          lastAuthorizationUrl: first.authorizationUrl,
          redirectUrl: first.redirectUrl,
        });
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        const callbacks = await Promise.all(
          [0, 1].map(() =>
            runGatewayOAuthCallback({
              serverName: "fixture",
              server: rawServer,
              code: authorizationCode(first.authorizationUrl),
              state: first.state,
            }),
          ),
        );
        expect(callbacks.map(({ res }) => res.statusCode).toSorted((a, b) => a - b)).toEqual([
          200, 404,
        ]);
        expect(await readMcpOAuthStore(identity.storeKey)).toMatchObject({
          tokens: { access_token: expect.any(String) },
        });
        expect(await readMcpOAuthStore(identity.storeKey)).not.toHaveProperty("codeVerifier");

        const secondIdentity = requesterIdentity("fixture", config.url, "sender-b");
        const second = await startMcpOAuthAuthorization(secondIdentity, config, {});
        assert(second.status === "redirect", "expected second MCP OAuth redirect");
        await expect(
          completeMcpOAuthAuthorization(secondIdentity, config, { code: "wrong-code" }),
        ).rejects.toThrow();
        expect(await readMcpOAuthStore(secondIdentity.storeKey)).toMatchObject({
          lastAuthorizationUrl: second.authorizationUrl,
          redirectUrl: second.redirectUrl,
          codeVerifier: expect.any(String),
        });
        expect(await readMcpOAuthStore(secondIdentity.storeKey)).not.toHaveProperty("tokens");

        const third = await startMcpOAuthAuthorization(secondIdentity, config, {});
        assert(third.status === "redirect", "expected third MCP OAuth redirect");
        expect(third.authorizationUrl).not.toBe(second.authorizationUrl);
        expect(await readPending(second.state)).toBeUndefined();
        expect(await readPending(third.state)).toBe(secondIdentity.storeKey);
        await expect(
          completeMcpOAuthAuthorization(secondIdentity, config, {
            code: authorizationCode(second.authorizationUrl),
          }),
        ).rejects.toThrow();
        expect((await readMcpOAuthStore(secondIdentity.storeKey)).lastAuthorizationUrl).toBe(
          third.authorizationUrl,
        );
        await expect(
          completeMcpOAuthAuthorization(secondIdentity, config, {
            code: authorizationCode(third.authorizationUrl),
          }),
        ).resolves.toBe("authorized");
      } finally {
        await fixture.close();
      }
    }, "openclaw-mcp-oauth-session-");
  });
});
