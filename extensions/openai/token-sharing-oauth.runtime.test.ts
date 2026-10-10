import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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

async function identityToken(kid = "test-key") {
  return new SignJWT({
    nonce: identityNonce ?? authorization.searchParams.get("nonce"),
    email: identityEmail,
  })
    .setProtectedHeader({ alg: "RS256", kid })
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
  state: "without-id-token" | "legacy" | "unbound",
) {
  const profileId = "openai:my-account";
  return {
    profileId,
    credential:
      state === "without-id-token"
        ? { ...credential, idToken: undefined }
        : state === "legacy"
          ? { ...credential, accountId: undefined }
          : { ...credential, accountId: undefined, idToken: undefined },
  };
}

async function loginCredential() {
  const result = await loginTokenSharing(context());
  const credential = result.profiles[0]!.credential;
  if (credential.type !== "oauth") {
    throw new Error("Expected OAuth");
  }
  return credential;
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
  it("delivers the remote browser URL before the sign-in note", async () => {
    const ctx = context();
    const visitBrowser = ctx.openUrl;
    let pendingUrl: string | undefined;
    ctx.isRemote = true;
    ctx.openUrl = async (url) => {
      pendingUrl = url;
    };
    ctx.prompter.openUrl = ctx.openUrl;
    ctx.prompter.note = vi.fn(async (message) => {
      // WizardSession attaches a queued external URL to the next emitted step.
      expect(pendingUrl).toBeDefined();
      expect(message).not.toContain(pendingUrl!);
      expect(message).toContain("8080:127.0.0.1:8080");
      await visitBrowser(pendingUrl!);
    });
    const result = await loginTokenSharing(ctx);
    expect(result.profiles[0]?.credential).toMatchObject({ access: "opaque-test-access" });
    expect((await callbackResponse!).status).toBe(200);
  });

  it("restarts a cancelled login without accepting its stale callback", async () => {
    const controller = new AbortController();
    const opened = createDeferred<URL>();
    const ctx = context();
    ctx.signal = AbortSignal.any([ctx.signal!, controller.signal]);
    ctx.openUrl = async (url) => {
      opened.resolve(new URL(url));
    };
    const login = loginTokenSharing(ctx);
    void login.catch(() => undefined);
    try {
      const previousAuthorization = await opened.promise;
      controller.abort();
      await expect(login).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();

      const nextContext = context();
      const completeNextCallback = nextContext.openUrl;
      nextContext.openUrl = async (url) => {
        const nextAuthorization = new URL(url);
        const previousState = previousAuthorization.searchParams.get("state")!;
        expect(nextAuthorization.searchParams.get("state")).not.toBe(previousState);
        const staleCallback = new URL(nextAuthorization.searchParams.get("redirect_uri")!);
        staleCallback.hostname = "127.0.0.1";
        staleCallback.search = new URLSearchParams({
          code: "cancelled-code",
          state: previousState,
        }).toString();
        const staleResponse = await fetch(staleCallback);
        expect(staleResponse.status).toBe(400);
        await staleResponse.text();
        expect(request).not.toHaveBeenCalled();
        await completeNextCallback(url);
      };
      const restarted = await loginTokenSharing(nextContext);
      expect(restarted.profiles).toHaveLength(1);
      expect(restarted.profiles[0]?.credential).toMatchObject({
        access: "opaque-test-access",
        authFlow: TOKEN_SHARING_AUTH_FLOW,
      });
      expect((await callbackResponse!).status).toBe(200);
      const exchanges = request.mock.calls.filter(([params]) => params.init?.method === "POST");
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]![0].init.body.get("code")).toBe("test-code");
    } finally {
      controller.abort();
      await login.catch(() => undefined);
    }
  });

  it("releases the callback listener on cancellation while a token request is still cleaning up", async () => {
    const releaseEntered = createDeferred<void>();
    const allowRelease = createDeferred<void>();
    const fetchResponse = request.getMockImplementation()!;
    request.mockImplementationOnce(async (params) => {
      const result = await fetchResponse(params);
      return {
        ...result,
        release: async () => {
          releaseEntered.resolve();
          await allowRelease.promise;
          await result.release();
        },
      };
    });
    const controller = new AbortController();
    const ctx = context();
    ctx.signal = AbortSignal.any([ctx.signal!, controller.signal]);
    const login = loginTokenSharing(ctx);
    const settled = vi.fn();
    void login.then(settled, settled);
    let originalCallback: Promise<Response> | undefined;
    try {
      await releaseEntered.promise;
      originalCallback = callbackResponse!;
      controller.abort();
      expect(settled).not.toHaveBeenCalled();

      const replacement = await loginTokenSharing(context());
      expect(replacement.profiles).toHaveLength(1);
      expect(replacement.profiles[0]?.credential).toMatchObject({
        access: "opaque-test-access",
        authFlow: TOKEN_SHARING_AUTH_FLOW,
      });
      expect((await callbackResponse!).status).toBe(200);
      await expect(originalCallback).rejects.toThrow();
      expect(settled).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      allowRelease.resolve();
      await expect(login).rejects.toThrow();
      await originalCallback?.then((response) => response.text()).catch(() => undefined);
    }
  });

  it.each(["without-id-token", "legacy"] as const)(
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
      const refreshRequest = request.mock.calls.find(([params]) => params.init?.method === "POST");
      expect(refreshRequest![0].init.body.get("client_id")).toBe(registeredId);
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

  it.each([
    { ids: [] },
    { ids: ["dynamic_agent_client"] },
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

  it.each(["without-id-token", "legacy", "unbound"] as const)(
    "rejects unmatched %s reconnect",
    async (state) => {
      const credential = await loginCredential();
      await (await callbackResponse!).text();
      const ctx = context();
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
      displayName: "Sign in with ChatGPT (Beta)",
      email: "owner@example.test",
      grantedScope: grantScope,
      authorizationScope: TOKEN_SHARING_LEGACY_SCOPE,
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
      displayName: "Sign in with ChatGPT (Beta, identity only)",
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

  it("rejects an ID token with the wrong nonce", async () => {
    identityNonce = "another-login";
    await expect(loginTokenSharing(context())).rejects.toThrow();
    expect((await callbackResponse!).status).toBe(400);
  });

  it.each([
    { replacement: undefined, scope: undefined },
    { replacement: "rotated-refresh", scope: "openid offline_access" },
  ])(
    "refreshes with the original client/resource, refresh token $replacement, and granted scope $scope",
    async ({ replacement, scope }) => {
      identityEmail = "owner@example.test";
      const credential = await loginCredential();
      request.mockClear();
      request.mockImplementation(async (params) => ({
        response: Response.json(
          params.url.endsWith("jwks.json")
            ? jwks
            : {
                access_token: "renewed-access",
                token_type: "Bearer",
                expires_in: 3600,
                ...(replacement ? { refresh_token: replacement } : {}),
                ...(scope === undefined ? {} : { scope }),
              },
        ),
        release: async () => undefined,
      }));
      // Existing SIWC profiles may retain the verified token without its email metadata.
      const refreshed = await refreshTokenSharingCredential({ ...credential, email: undefined });
      const tokenRequest = request.mock.calls.find(([params]) => params.init?.method === "POST");
      expect(Object.fromEntries(tokenRequest![0].init.body)).toEqual({
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
      const credential = await loginCredential();
      identityEmail = email;
      const refreshed = await refreshTokenSharingCredential(credential);
      expect(refreshed.email).toBe(email);
      expect(refreshed.accountId).toBe(credential.accountId);
    },
  );

  it("loads signing keys before rotating and needs no network after the token response", async () => {
    const credential = await loginCredential();
    const renewedIdentity = await identityToken();
    request.mockClear();
    let rotated = false;
    request.mockImplementation(async (params) => {
      if (params.url.endsWith("jwks.json")) {
        if (rotated) {
          throw Object.assign(new Error("Signing-key connection reset"), { code: "ECONNRESET" });
        }
        return { response: Response.json(jwks), release: async () => undefined };
      }
      rotated = true;
      return {
        response: Response.json({
          access_token: "renewed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          id_token: renewedIdentity,
        }),
        release: async () => undefined,
      };
    });

    await expect(refreshTokenSharingCredential(credential)).resolves.toMatchObject({
      access: "renewed-access",
      refresh: "rotated-refresh",
      accountId: credential.accountId,
    });
    expect(request.mock.calls.map(([params]) => params.url)).toEqual([
      `${TOKEN_SHARING_ISSUER}/.well-known/jwks.json`,
      `${TOKEN_SHARING_ISSUER}/api/accounts/oauth/token`,
    ]);
  });

  it.each(["unreachable", "malformed"])(
    "does not consume the refresh token when signing keys are %s",
    async (failure) => {
      const credential = await loginCredential();
      const renewedIdentity = await identityToken();
      request.mockClear();
      request.mockImplementation(async (params) => {
        if (params.url.endsWith("jwks.json")) {
          if (failure === "unreachable") {
            throw Object.assign(new Error("Signing-key connection reset"), { code: "ECONNRESET" });
          }
          return { response: Response.json({ keys: "invalid" }), release: async () => undefined };
        }
        return {
          response: Response.json({
            access_token: "renewed-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
            token_type: "Bearer",
            id_token: renewedIdentity,
          }),
          release: async () => undefined,
        };
      });

      await expect(refreshTokenSharingCredential(credential)).rejects.toThrow(
        failure === "unreachable" ? "Signing-key connection reset" : "invalid signing key set",
      );
      expect(request.mock.calls.map(([params]) => params.url)).toEqual([
        `${TOKEN_SHARING_ISSUER}/.well-known/jwks.json`,
      ]);
    },
  );

  it.each(["signature", "subject", "key"])(
    "still rejects a renewed ID token with a different %s using prefetched keys",
    async (failure) => {
      const credential = await loginCredential();
      if (failure === "subject") {
        identitySubject = "another-user";
      }
      const signed = await identityToken(failure === "key" ? "rotated-signing-key" : "test-key");
      const [header, payload, signature] = signed.split(".");
      const renewedIdentity =
        failure === "signature"
          ? `${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`
          : signed;
      request.mockClear();
      request.mockImplementation(async (params) => ({
        response: Response.json(
          params.url.endsWith("jwks.json")
            ? jwks
            : {
                access_token: "renewed-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
                token_type: "Bearer",
                id_token: renewedIdentity,
              },
        ),
        release: async () => undefined,
      }));

      await expect(refreshTokenSharingCredential(credential)).rejects.toThrow(
        failure === "subject"
          ? "ChatGPT account changed"
          : failure === "key"
            ? "no applicable key found"
            : "signature verification failed",
      );
      expect(request.mock.calls.map(([params]) => params.url)).toEqual([
        `${TOKEN_SHARING_ISSUER}/.well-known/jwks.json`,
        `${TOKEN_SHARING_ISSUER}/api/accounts/oauth/token`,
      ]);
    },
  );

  it.each([
    { metadata: { accountId: undefined }, expectedError: "Sign in again" },
    {
      metadata: { tokenEndpoint: "https://example.com/token" },
      expectedError: "registration is missing",
    },
    { metadata: { clientId: "dynamic_agent_client" }, expectedError: "registration is missing" },
  ])(
    "rejects invalid refresh registration metadata $metadata before sending credentials",
    async ({ metadata, expectedError }) => {
      const credential = await loginCredential();
      request.mockClear();
      await expect(refreshTokenSharingCredential({ ...credential, ...metadata })).rejects.toThrow(
        expectedError,
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("classifies revoked refreshes without exposing the provider response or credentials", async () => {
    const credential = await loginCredential();
    request.mockImplementation(async (params) => ({
      response: Response.json(
        params.url.endsWith("jwks.json")
          ? jwks
          : { error: "invalid_grant", error_description: "secret-provider-detail" },
        { status: params.url.endsWith("jwks.json") ? 200 : 400 },
      ),
      release: async () => undefined,
    }));
    await expect(refreshTokenSharingCredential(credential)).rejects.toMatchObject({
      message: "ChatGPT connection expired or was revoked. Sign in again to reconnect.",
      oauthRefreshFailure: { reason: "invalid_grant" },
    });
  });
});
