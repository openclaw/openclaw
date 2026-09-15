import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: request }));

import { loginTokenSharing, refreshTokenSharingCredential } from "./token-sharing-oauth.runtime.js";
import {
  IDENTITY_AUTH_FLOW,
  TOKEN_SHARING_AUTH_FLOW,
  TOKEN_SHARING_ISSUER,
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

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test-key" }] };
});

async function identityToken() {
  return new SignJWT({ nonce: identityNonce ?? authorization.searchParams.get("nonce") })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(TOKEN_SHARING_ISSUER)
    .setAudience(idTokenAudience)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
}

function context(): ProviderAuthContext {
  return {
    prompter: { note: vi.fn(async () => undefined) },
    openUrl: async (url: string) => {
      authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set(callbackError ? "error" : "code", callbackError ?? "test-code");
      callbackResponse = fetch(callback);
      void callbackResponse.catch(() => undefined);
    },
    isRemote: false,
    assertCurrent: vi.fn(),
  } as unknown as ProviderAuthContext;
}

beforeEach(() => {
  request.mockReset();
  grantScope = TOKEN_SHARING_SCOPE;
  idTokenAudience = clientId;
  identityNonce = undefined;
  callbackError = undefined;
  callbackResponse = undefined;
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
  it("uses public PKCE/resource parameters, verifies identity, and returns a distinct renewable profile", async () => {
    const result = await loginTokenSharing(context(), clientId);
    const exchange = request.mock.calls.find(([params]) => params.init?.method === "POST")![0];
    const form = exchange.init.body as URLSearchParams;
    expect(authorization.origin + authorization.pathname).toBe(
      `${TOKEN_SHARING_ISSUER}/api/accounts/authorize`,
    );
    expect(authorization.searchParams.get("scope")).toBe(TOKEN_SHARING_SCOPE);
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
    expect(result.profiles[0]?.profileId).toMatch(/^openai:token-sharing:[a-f0-9]{24}$/u);
    expect(result.profiles[0]?.credential).toMatchObject({
      type: "oauth",
      access: "opaque-test-access",
      refresh: "test-refresh",
      clientId,
      issuer: TOKEN_SHARING_ISSUER,
      authFlow: TOKEN_SHARING_AUTH_FLOW,
    });
    expect(result.profiles[0]?.credential).not.toHaveProperty("accountId");
    expect(await (await callbackResponse!).text()).toContain("token sharing is connected");
  });

  it("retains identity when sharing is declined without choosing a model or another funding source", async () => {
    grantScope = "openid offline_access";
    const result = await loginTokenSharing(context(), clientId);
    expect(result.profiles[0]?.credential).toMatchObject({ authFlow: IDENTITY_AUTH_FLOW });
    expect(result).not.toHaveProperty("defaultModel");
    expect(result).not.toHaveProperty("configPatch");
    expect(result.notes?.[0]).toContain("token sharing is disabled");
  });

  it("distinguishes denied authorization from completed identity-only sign-in", async () => {
    callbackError = "access_denied";
    await expect(loginTokenSharing(context(), clientId)).rejects.toThrow(
      "authorization was declined",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["audience", "nonce"])("rejects an ID token with the wrong %s", async (field) => {
    if (field === "audience") idTokenAudience = "another-client";
    else identityNonce = "another-login";
    await expect(loginTokenSharing(context(), clientId)).rejects.toThrow();
    expect((await callbackResponse!).status).toBe(400);
  });

  it("rejects an unrelated callback without consuming the active login", async () => {
    const ctx = context();
    const openUrl = ctx.openUrl;
    ctx.openUrl = async (url) => {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const malformed = httpRequest(
          { hostname: "localhost", port: 8080, path: "http://%" },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        malformed.once("error", reject);
        malformed.end();
      });
      expect(status).toBe(400);
      const callback = new URL("http://localhost:8080/auth/callback?code=unrelated&state=wrong");
      expect((await fetch(callback)).status).toBe(400);
      await openUrl(url);
    };
    const result = await loginTokenSharing(ctx, clientId);
    expect(result.profiles).toHaveLength(1);
  });

  it.each([undefined, "rotated-refresh"])(
    "refreshes with the original client/resource and replacement %s",
    async (replacement) => {
      const login = await loginTokenSharing(context(), clientId);
      const credential = login.profiles[0]!.credential;
      if (credential.type !== "oauth") throw new Error("Expected OAuth");
      request.mockClear();
      request.mockResolvedValue({
        response: Response.json({
          access_token: "renewed-access",
          token_type: "Bearer",
          expires_in: 3600,
          ...(replacement ? { refresh_token: replacement } : {}),
        }),
        release: async () => undefined,
      });
      const refreshed = await refreshTokenSharingCredential(credential);
      expect(Object.fromEntries(request.mock.calls[0]![0].init.body)).toEqual({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: "test-refresh",
        resource: TOKEN_SHARING_RESOURCE,
      });
      expect(refreshed).toMatchObject({
        access: "renewed-access",
        refresh: replacement ?? "test-refresh",
        authFlow: TOKEN_SHARING_AUTH_FLOW,
        idToken: credential.idToken,
      });
    },
  );

  it("rejects a changed refresh destination before sending credentials", async () => {
    const login = await loginTokenSharing(context(), clientId);
    const credential = login.profiles[0]!.credential;
    if (credential.type !== "oauth") throw new Error("Expected OAuth");
    request.mockClear();
    await expect(
      refreshTokenSharingCredential({ ...credential, tokenEndpoint: "https://example.com/token" }),
    ).rejects.toThrow("registration is missing");
    expect(request).not.toHaveBeenCalled();
  });

  it("classifies revoked refreshes without exposing the provider response or credentials", async () => {
    const login = await loginTokenSharing(context(), clientId);
    const credential = login.profiles[0]!.credential;
    if (credential.type !== "oauth") throw new Error("Expected OAuth");
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
