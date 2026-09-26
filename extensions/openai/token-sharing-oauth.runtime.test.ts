import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: request }));

import { buildOpenAISetupProvider } from "./setup-api.js";
import { loginTokenSharing, refreshTokenSharingCredential } from "./token-sharing-oauth.runtime.js";
import {
  IDENTITY_AUTH_FLOW,
  TOKEN_SHARING_AUTH_FLOW,
  TOKEN_SHARING_CLIENT_ID,
  TOKEN_SHARING_ISSUER,
  TOKEN_SHARING_LEGACY_SCOPE,
  TOKEN_SHARING_RESOURCE,
  TOKEN_SHARING_SCOPE,
} from "./token-sharing.js";

const clientId = "test-public-client";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };
let authorization: URL;
let callbackResponse: Promise<Response> | undefined;
let grantScope: string;
let idTokenAudience: string;
let callbackError: string | undefined;
let identityNonce: string | undefined;
let callbackClientIds: string[];
let identitySubject: string;
let identityEmail: string | undefined;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test-key" }] };
});

async function identityToken() {
  return new SignJWT({
    nonce: identityNonce ?? authorization.searchParams.get("nonce"),
    email: identityEmail,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(TOKEN_SHARING_ISSUER)
    .setAudience(idTokenAudience)
    .setSubject(identitySubject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
}

function context(): ProviderAuthContext {
  const callbackOwner = new AbortController();
  return {
    signal: callbackOwner.signal,
    prompter: {
      note: vi.fn(async () => undefined),
      select: vi.fn(async ({ initialValue }: { initialValue: string }) => initialValue),
    },
    existingProfiles: [
      {
        profileId: "openai:existing",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "old-access",
          refresh: "old-refresh",
          expires: 0,
          clientId,
          accountId: createHash("sha256")
            .update(`${TOKEN_SHARING_ISSUER}\0${clientId}\0user-1`)
            .digest("hex"),
          issuer: TOKEN_SHARING_ISSUER,
          tokenEndpoint: `${TOKEN_SHARING_ISSUER}/api/accounts/oauth/token`,
          authFlow: TOKEN_SHARING_AUTH_FLOW,
        },
      },
    ],
    openUrl: async (url: string) => {
      authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set(callbackError ? "error" : "code", callbackError ?? "test-code");
      for (const id of callbackClientIds) {
        callback.searchParams.append("client_id", id);
      }
      // SSH forwards commonly target IPv4 even when localhost resolves to IPv6 first.
      callback.hostname = "127.0.0.1";
      callbackResponse = fetch(callback);
      void callbackResponse.catch((error: unknown) => callbackOwner.abort(error));
    },
    isRemote: false,
    assertCurrent: vi.fn(),
  } as unknown as ProviderAuthContext;
}

function reconnectProfile(
  credential: OAuthCredential,
  state: "saved" | "without-id-token" | "legacy" | "unbound",
) {
  const profileId = "openai:my-account";
  return {
    profileId,
    credential:
      state === "without-id-token"
        ? { ...credential, idToken: undefined }
        : state === "legacy"
          ? { ...credential, accountId: undefined }
          : state === "unbound"
            ? { ...credential, accountId: undefined, idToken: undefined }
            : credential,
  };
}

beforeEach(() => {
  request.mockReset();
  grantScope = TOKEN_SHARING_SCOPE;
  idTokenAudience = clientId;
  identityNonce = undefined;
  callbackError = undefined;
  callbackResponse = undefined;
  callbackClientIds = [];
  identitySubject = "user-1";
  identityEmail = undefined;
  request.mockImplementation(async (params) => {
    params.beforeRequest?.();
    const body = params.url.endsWith("jwks.json")
      ? jwks
      : {
          access_token: "opaque-test-access",
          refresh_token: "test-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          id_token: await identityToken(),
          scope: grantScope,
        };
    return { response: Response.json(body), release: vi.fn(async () => undefined) };
  });
});

afterEach(async () => {
  await callbackResponse?.then((response) => response.text()).catch(() => undefined);
});

describe("ChatGPT token-sharing authorization", () => {
  it.each([
    { isRemote: false, browserLink: true },
    { isRemote: true, browserLink: true },
    { isRemote: true, browserLink: false },
  ])(
    "delivers the browser URL before the sign-in note (remote=$isRemote, browser link=$browserLink)",
    async ({ isRemote, browserLink }) => {
      const ctx = context();
      const visitBrowser = ctx.openUrl;
      let pendingUrl: string | undefined;
      ctx.isRemote = isRemote;
      ctx.openUrl = async (url) => {
        pendingUrl = url;
      };
      if (browserLink) {
        ctx.prompter.openUrl = ctx.openUrl;
      }
      ctx.prompter.note = vi.fn(async (message) => {
        // WizardSession attaches a queued external URL to the next emitted step.
        expect(pendingUrl).toBeDefined();
        if (browserLink) {
          expect(message).not.toContain(pendingUrl!);
        } else {
          expect(message).toContain(pendingUrl!);
        }
        if (isRemote) {
          expect(message).toContain("8080:127.0.0.1:8080");
        }
        await visitBrowser(pendingUrl!);
      });
      const result = await loginTokenSharing(ctx);
      expect(result.profiles[0]?.credential).toMatchObject({ access: "opaque-test-access" });
      expect((await callbackResponse!).status).toBe(200);
    },
  );

  it.each(["saved", "without-id-token", "legacy"] as const)(
    "reuses registered client for %s reconnect",
    async (state) => {
      const method = buildOpenAISetupProvider().auth.find((entry) => entry.id === "siwc")!;
      const ctx = context();
      ctx.existingProfiles = [];
      const registeredId = "oaiapp_testregistered";
      callbackClientIds = [registeredId];
      idTokenAudience = registeredId;
      grantScope = "openid resource.invoke chatgpt.tokens.use.direct offline_access";
      const registered = await method.run(ctx);
      expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
      expect(authorization.searchParams.get("agent_name_hint")).toBe("OpenClaw");
      expect(authorization.searchParams.get("scope")).toBe(
        "openid email profile resource.invoke chatgpt.tokens.use.direct offline_access",
      );
      const credential = registered.profiles[0]!.credential;
      expect(credential).toMatchObject({
        clientId: registeredId,
        authorizationScope: TOKEN_SHARING_SCOPE,
        grantedScope: grantScope,
        authFlow: TOKEN_SHARING_AUTH_FLOW,
      });
      const exchange = request.mock.calls.find(([params]) => params.init?.method === "POST")![0];
      expect(exchange.init.body.get("client_id")).toBe(registeredId);
      expect(exchange.init.body.get("code_verifier")).toBeTruthy();
      expect((await callbackResponse!).status).toBe(200);
      await (await callbackResponse!).text();

      if (credential.type !== "oauth") {
        throw new Error("Expected OAuth");
      }
      request.mockClear();
      const refreshed = await refreshTokenSharingCredential(credential);
      expect(request.mock.calls[0]![0].init.body.get("client_id")).toBe(registeredId);
      expect(refreshed.clientId).toBe(registeredId);

      const reconnect = context();
      // Named CLI profiles must keep their identity when reconnecting, too.
      reconnect.existingProfiles = [
        reconnectProfile(
          {
            ...credential,
            authorizationScope:
              "openid email profile resource.invoke chatpass.enable.request.direct offline_access",
          },
          state,
        ),
      ];
      callbackClientIds = [];
      const reconnected = await method.run(reconnect);
      expect(authorization.searchParams.get("client_id")).toBe(registeredId);
      expect(authorization.searchParams.has("agent_name_hint")).toBe(false);
      expect(authorization.searchParams.get("scope")).toBe(TOKEN_SHARING_SCOPE);
      expect(reconnected.profiles[0]?.profileId).toBe("openai:my-account");
      expect(reconnected.profiles[0]?.credential).toMatchObject({ clientId: registeredId });
    },
  );

  it("starts a fresh registration when another account or workspace is selected", async () => {
    const ctx = context();
    ctx.prompter.select = vi.fn().mockResolvedValue(TOKEN_SHARING_CLIENT_ID);
    callbackClientIds = ["oaiapp_anotherregistration"];
    idTokenAudience = callbackClientIds[0]!;
    const result = await loginTokenSharing(ctx);
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(result.profiles[0]?.credential).toMatchObject({ clientId: idTokenAudience });
    expect(ctx.existingProfiles?.[0]?.credential).toMatchObject({ access: "old-access", clientId });
  });

  it.each([
    { ids: [] },
    { ids: ["dynamic_agent_client"] },
    { ids: ["not-a-registered-client"] },
    { ids: ["oaiapp_first", "oaiapp_second"] },
  ])("rejects registration callback client IDs $ids before exchange", async ({ ids }) => {
    const ctx = context();
    ctx.existingProfiles = [];
    callbackClientIds = ids;
    await expect(loginTokenSharing(ctx)).rejects.toThrow("invalid OAuth client ID");
    expect(request).not.toHaveBeenCalled();
    expect((await callbackResponse!).status).toBe(400);
  });

  it("rejects replacement of an existing client ID in an ordinary login callback", async () => {
    callbackClientIds = ["oaiapp_substituted"];
    await expect(loginTokenSharing(context())).rejects.toThrow("invalid OAuth client ID");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps existing credentials that return the legacy direct-sharing scope usable", async () => {
    grantScope = "openid offline_access resource.invoke chatgpt.tokens.use.direct";
    const result = await loginTokenSharing(context());
    expect(authorization.searchParams.get("scope")).toBe(TOKEN_SHARING_LEGACY_SCOPE);
    expect(result.profiles[0]?.credential).toMatchObject({
      authFlow: TOKEN_SHARING_AUTH_FLOW,
      authorizationScope: TOKEN_SHARING_LEGACY_SCOPE,
    });
  });

  it.each(["saved", "without-id-token", "legacy", "unbound"] as const)(
    "rejects unmatched %s reconnect",
    async (state) => {
      const original = await loginTokenSharing(context());
      await (await callbackResponse!).text();
      const ctx = context();
      const credential = original.profiles[0]!.credential;
      if (credential.type !== "oauth") {
        throw new Error("Expected OAuth");
      }
      ctx.existingProfiles = [reconnectProfile(credential, state)];
      identitySubject = state === "unbound" ? "user-1" : "another-user";
      await expect(loginTokenSharing(ctx)).rejects.toThrow("ChatGPT account changed");
      expect((await callbackResponse!).status).toBe(400);
    },
  );

  it("rejects a registration ID with an ID token addressed to the entry marker", async () => {
    const ctx = context();
    ctx.existingProfiles = [];
    callbackClientIds = ["oaiapp_testregistered"];
    idTokenAudience = TOKEN_SHARING_CLIENT_ID;
    await expect(loginTokenSharing(ctx)).rejects.toThrow();
    expect((await callbackResponse!).status).toBe(400);
  });

  it("uses public PKCE/resource parameters, verifies identity, and returns a distinct renewable profile", async () => {
    identityEmail = "owner@example.test";
    const result = await loginTokenSharing(context());
    const exchange = request.mock.calls.find(([params]) => params.init?.method === "POST")![0];
    const form = exchange.init.body as URLSearchParams;
    expect(authorization.origin + authorization.pathname).toBe(
      `${TOKEN_SHARING_ISSUER}/api/accounts/authorize`,
    );
    expect(authorization.searchParams.get("scope")).toBe(TOKEN_SHARING_LEGACY_SCOPE);
    expect(authorization.searchParams.get("resource")).toBe(TOKEN_SHARING_RESOURCE);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(form.get("code_verifier")!).digest("base64url"),
    );
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      client_id: clientId,
      code: "test-code",
      resource: TOKEN_SHARING_RESOURCE,
      redirect_uri: "http://localhost:8080/auth/callback",
    });
    expect(form.has("client_secret")).toBe(false);
    expect(result.profiles[0]?.profileId).toBe("openai:existing");
    expect(result.profiles[0]?.credential).toMatchObject({
      type: "oauth",
      access: "opaque-test-access",
      refresh: "test-refresh",
      clientId,
      issuer: TOKEN_SHARING_ISSUER,
      authFlow: TOKEN_SHARING_AUTH_FLOW,
      displayName: "Sign in with ChatGPT",
      email: "owner@example.test",
      grantedScope: grantScope,
    });
    expect(result.profiles[0]?.credential).toHaveProperty(
      "accountId",
      createHash("sha256")
        .update(`${TOKEN_SHARING_ISSUER}\0${clientId}\0${identitySubject}`)
        .digest("hex"),
    );
    expect(await (await callbackResponse!).text()).toContain("token sharing is connected");
    expect(result.notes?.[0]).toContain("Eligible Responses requests use your Codex allowance.");
  });

  it("retains identity when sharing is declined without choosing a model or another funding source", async () => {
    grantScope = "openid offline_access";
    const result = await loginTokenSharing(context());
    expect(result.profiles[0]?.credential).toMatchObject({
      authFlow: IDENTITY_AUTH_FLOW,
      displayName: "Sign in with ChatGPT (identity only)",
      grantedScope: "openid offline_access",
      authorizationScope: TOKEN_SHARING_LEGACY_SCOPE,
    });
    expect(result).not.toHaveProperty("defaultModel");
    expect(result).not.toHaveProperty("configPatch");
    expect(result.notes?.[0]).toContain("token sharing is disabled");
  });

  it("distinguishes denied authorization from completed identity-only sign-in", async () => {
    callbackError = "access_denied";
    await expect(loginTokenSharing(context())).rejects.toThrow("authorization was declined");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["audience", "nonce"])("rejects an ID token with the wrong %s", async (field) => {
    if (field === "audience") {
      idTokenAudience = "another-client";
    } else {
      identityNonce = "another-login";
    }
    await expect(loginTokenSharing(context())).rejects.toThrow();
    expect((await callbackResponse!).status).toBe(400);
  });

  it("rejects an unrelated callback without consuming the active login", async () => {
    const ctx = context();
    const openUrl = ctx.openUrl;
    ctx.openUrl = async (url) => {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const malformed = httpRequest(
          { hostname: "127.0.0.1", port: 8080, path: "http://%" },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        malformed.once("error", reject);
        malformed.end();
      });
      expect(status).toBe(400);
      const callback = new URL("http://127.0.0.1:8080/auth/callback?code=unrelated&state=wrong");
      expect((await fetch(callback)).status).toBe(400);
      await openUrl(url);
    };
    const result = await loginTokenSharing(ctx);
    expect(result.profiles).toHaveLength(1);
  });

  it("requires reconnect for an older preview credential without a bound account identity", async () => {
    const login = await loginTokenSharing(context());
    const credential = login.profiles[0]!.credential;
    if (credential.type !== "oauth") {
      throw new Error("Expected OAuth");
    }
    request.mockClear();
    await expect(
      refreshTokenSharingCredential({ ...credential, accountId: undefined }),
    ).rejects.toThrow("Sign in again");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { replacement: undefined, scope: undefined },
    { replacement: "rotated-refresh", scope: undefined },
    { replacement: "rotated-refresh", scope: "openid offline_access" },
  ])(
    "refreshes with the original client/resource, refresh token $replacement, and granted scope $scope",
    async ({ replacement, scope }) => {
      identityEmail = "owner@example.test";
      const login = await loginTokenSharing(context());
      const credential = login.profiles[0]!.credential;
      if (credential.type !== "oauth") {
        throw new Error("Expected OAuth");
      }
      request.mockClear();
      request.mockResolvedValue({
        response: Response.json({
          access_token: "renewed-access",
          token_type: "Bearer",
          expires_in: 3600,
          ...(replacement ? { refresh_token: replacement } : {}),
          ...(scope === undefined ? {} : { scope }),
        }),
        release: async () => undefined,
      });
      // Existing SIWC profiles may retain the verified token without its email metadata.
      const refreshed = await refreshTokenSharingCredential({ ...credential, email: undefined });
      expect(Object.fromEntries(request.mock.calls[0]![0].init.body)).toEqual({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: "test-refresh",
        resource: TOKEN_SHARING_RESOURCE,
      });
      expect(refreshed).toMatchObject({
        access: "renewed-access",
        refresh: replacement ?? "test-refresh",
        authFlow: scope === undefined ? TOKEN_SHARING_AUTH_FLOW : IDENTITY_AUTH_FLOW,
        grantedScope: scope ?? grantScope,
        idToken: credential.idToken,
        email: "owner@example.test",
        accountId: credential.accountId,
        authorizationScope: TOKEN_SHARING_LEGACY_SCOPE,
      });
    },
  );

  it.each(["updated@example.test", undefined])(
    "uses the renewed ID token's email %s without changing the account binding",
    async (email) => {
      identityEmail = "owner@example.test";
      const login = await loginTokenSharing(context());
      const credential = login.profiles[0]!.credential;
      if (credential.type !== "oauth") {
        throw new Error("Expected OAuth");
      }
      identityEmail = email;
      const refreshed = await refreshTokenSharingCredential(credential);
      expect(refreshed.email).toBe(email);
      expect(refreshed.accountId).toBe(credential.accountId);
    },
  );

  it.each([{ tokenEndpoint: "https://example.com/token" }, { clientId: "dynamic_agent_client" }])(
    "rejects invalid refresh registration metadata %j before sending credentials",
    async (metadata) => {
      const login = await loginTokenSharing(context());
      const credential = login.profiles[0]!.credential;
      if (credential.type !== "oauth") {
        throw new Error("Expected OAuth");
      }
      request.mockClear();
      await expect(refreshTokenSharingCredential({ ...credential, ...metadata })).rejects.toThrow(
        "registration is missing",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("classifies revoked refreshes without exposing the provider response or credentials", async () => {
    const login = await loginTokenSharing(context());
    const credential = login.profiles[0]!.credential;
    if (credential.type !== "oauth") {
      throw new Error("Expected OAuth");
    }
    request.mockResolvedValue({
      response: Response.json(
        { error: "invalid_grant", error_description: "secret-provider-detail" },
        { status: 400 },
      ),
      release: async () => undefined,
    });
    await expect(refreshTokenSharingCredential(credential)).rejects.toMatchObject({
      message: "ChatGPT connection expired or was revoked. Sign in again to reconnect.",
      oauthRefreshFailure: { reason: "invalid_grant" },
    });
  });
});
