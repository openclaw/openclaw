import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { loginChutes, refreshChutesOAuthCredential } from "./oauth.js";

const CHUTES_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
const CHUTES_USERINFO_ENDPOINT = "https://api.chutes.ai/idp/userinfo";
const REDIRECT_URI = "http://127.0.0.1:1456/oauth-callback";

const waitForLocalOAuthCallbackMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  waitForLocalOAuthCallback: waitForLocalOAuthCallbackMock,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.resetModules();
});

function boundedErrorResponse(body: string, status = 500) {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
      },
      cancel,
    }),
    { status },
  );
  const releaseLock = vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock");
  const text = vi
    .spyOn(response, "text")
    .mockRejectedValue(new Error("response.text() should not be called"));
  return { response, cancel, releaseLock, text };
}

function fetchInputUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function chunkedResponse(chunk: Uint8Array, chunks: number, status: number) {
  let bytesPulled = 0;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (bytesPulled >= chunks * chunk.length) {
          controller.close();
          return;
        }
        bytesPulled += chunk.length;
        controller.enqueue(chunk);
      },
      cancel,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
  return {
    response,
    cancel,
    get bytesPulled() {
      return bytesPulled;
    },
  };
}

function oauthFetch({
  token = jsonResponse({ access_token: "at_123", refresh_token: "rt_123", expires_in: 3600 }),
  userInfo = async () => new Response("not found", { status: 404 }),
}: {
  token?: Response;
  userInfo?: (init?: RequestInit) => Promise<Response>;
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    switch (fetchInputUrl(input)) {
      case CHUTES_TOKEN_ENDPOINT:
        return token;
      case CHUTES_USERINFO_ENDPOINT:
        return await userInfo(init);
      default:
        return new Response("not found", { status: 404 });
    }
  });
}

function rejectWhenAborted(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  if (!signal) {
    return Promise.reject(new Error("missing OAuth request signal"));
  }
  return new Promise((_, reject) => {
    const rejectWithReason = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("OAuth request aborted"));
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

function loginWithFetch(fetchFn: typeof fetch, signal?: AbortSignal) {
  vi.stubGlobal("fetch", fetchFn);
  let state = "";
  return loginChutes({
    app: { clientId: "cid_test", redirectUri: REDIRECT_URI, scopes: ["openid"] },
    manual: true,
    onAuth: async ({ url }) => {
      state = new URL(url).searchParams.get("state") ?? "";
    },
    onPrompt: async () => `${REDIRECT_URI}?code=code_test&state=${state}`,
    signal,
  });
}

function refreshWithFetch(fetchFn: typeof fetch, overrides: Partial<OAuthCredential> = {}) {
  vi.stubGlobal("fetch", fetchFn);
  return refreshChutesOAuthCredential(createStoredCredential(overrides));
}

function createStoredCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "chutes",
    access: "at_old",
    refresh: "rt_old",
    expires: 1_000_000,
    clientId: "cid_stored",
    email: "fred@example.com",
    displayName: "Fred",
    accountId: "acct_123",
    copyToAgents: true,
    ...overrides,
  };
}

afterEach(() => {
  waitForLocalOAuthCallbackMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("uses an IPv6 loopback callback without changing the OAuth redirect URI", async () => {
  const redirectUri = "http://[::1]:1456/oauth-callback";
  waitForLocalOAuthCallbackMock.mockResolvedValue({ code: "code_test", state: "state_test" });
  const fetchFn = oauthFetch({});
  vi.stubGlobal("fetch", fetchFn);
  await expect(
    loginChutes({
      app: { clientId: "cid_test", redirectUri, scopes: ["openid"] },
      onAuth: vi.fn(async () => {}),
      onPrompt: vi.fn(async () => {
        throw new Error("IPv6 callback must not require manual fallback");
      }),
    }),
  ).resolves.toMatchObject({ access: "at_123", refresh: "rt_123" });
  expect(waitForLocalOAuthCallbackMock).toHaveBeenCalledWith(
    expect.objectContaining({ hostname: "::1", port: 1456, redirectUri }),
  );
  const tokenRequest = fetchFn.mock.calls[0]?.[1]?.body;
  expect(tokenRequest).toBeInstanceOf(URLSearchParams);
  expect((tokenRequest as URLSearchParams).get("redirect_uri")).toBe(redirectUri);
});

it("rejects unsafe token lifetimes before storing credentials", async () => {
  const fetchFn = oauthFetch({
    token: new Response(
      '{"access_token":"at_unsafe","refresh_token":"rt_unsafe","expires_in":1e309}',
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  });
  await expect(loginWithFetch(fetchFn)).rejects.toThrow(
    "Chutes token exchange returned invalid expires_in",
  );
});

it("bounds token exchange error bodies without requiring response.text()", async () => {
  const leakedClientSecret = "oauth-client-secret-1234567890";
  const errorResponse = boundedErrorResponse(
    `${`client_secret=${leakedClientSecret}&reason=unavailable `.repeat(1024)}tail-marker`,
    502,
  );
  const fetchFn = oauthFetch({ token: errorResponse.response });
  const error = await loginWithFetch(fetchFn).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(error).toMatchObject({ name: "ProviderHttpError", status: 502 });
  expect(message).toContain("Chutes token exchange failed (502): client_secret=");
  expect(message).not.toContain(leakedClientSecret);
  expect(message).not.toContain("tail-marker");
  expect((error as { errorBody?: string }).errorBody).not.toContain(leakedClientSecret);
  expect(errorResponse.text).not.toHaveBeenCalled();
  expect(errorResponse.cancel).toHaveBeenCalledTimes(1);
  expect(errorResponse.releaseLock).toHaveBeenCalledTimes(1);
  expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("cancels oversized token exchange JSON body via the 16 MiB provider cap", async () => {
  const oversizedTokenJson = chunkedResponse(new Uint8Array(1024 * 1024), 32, 200);
  const fetchFn = oauthFetch({
    token: oversizedTokenJson.response,
    userInfo: async () => jsonResponse({ login: "test", name: "Test" }),
  });
  await expect(loginWithFetch(fetchFn)).rejects.toThrow(
    /Chutes token exchange: JSON response exceeds 16777216 bytes/,
  );
  expect(oversizedTokenJson.cancel).toHaveBeenCalledOnce();
  expect(oversizedTokenJson.bytesPulled).toBeLessThan(32 * 1024 * 1024);
});

it("keeps issued tokens when userinfo exceeds the fixed deadline", async () => {
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    expect(delay).toBe(30_000);
    return AbortSignal.abort(new DOMException("OAuth request timed out", "TimeoutError"));
  });
  const fetchFn = oauthFetch({ userInfo: rejectWhenAborted });
  const credentials = await loginWithFetch(fetchFn);
  expect(credentials).toMatchObject({
    access: "at_123",
    refresh: "rt_123",
    email: undefined,
    accountId: undefined,
  });
  expect(timeoutSpy).toHaveBeenCalledTimes(2);
});

it("cancels the userinfo error response body when profile lookup fails", async () => {
  const userInfoResponse = chunkedResponse(
    new TextEncoder().encode("temporarily unavailable"),
    1,
    503,
  );
  const fetchFn = oauthFetch({ userInfo: async () => userInfoResponse.response });
  const credentials = await loginWithFetch(fetchFn);
  expect(userInfoResponse.cancel).toHaveBeenCalledOnce();
  expect(credentials).toMatchObject({ access: "at_123", email: undefined, accountId: undefined });
});

it("cancels authentication when the caller aborts during userinfo", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");
  const fetchFn = oauthFetch({
    userInfo: async (init) => {
      controller.abort(reason);
      return await rejectWhenAborted(init);
    },
  });
  await expect(loginWithFetch(fetchFn, controller.signal)).rejects.toBe(reason);
});

it("refreshes through the Chutes token endpoint and preserves credential metadata", async () => {
  vi.stubEnv("CHUTES_CLIENT_ID", "cid_env");
  vi.stubEnv("CHUTES_CLIENT_SECRET", "secret_env");
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(fetchInputUrl(input)).toBe(CHUTES_TOKEN_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      client_id: "cid_stored",
      refresh_token: "rt_old",
      client_secret: "secret_env",
    });
    return jsonResponse({ access_token: "at_new", refresh_token: "rt_new", expires_in: 1800 });
  });
  const credential = createStoredCredential();
  const now = 2_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  await expect(refreshWithFetch(fetchFn)).resolves.toEqual({
    ...credential,
    access: "at_new",
    refresh: "rt_new",
    expires: now + 1800 * 1000 - 5 * 60 * 1000,
  });
  expect(timeoutSpy).toHaveBeenCalledOnce();
  expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("falls back to CHUTES_CLIENT_ID when the credential has no client id", async () => {
  vi.stubEnv("CHUTES_CLIENT_ID", "cid_env");
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    if (!(body instanceof URLSearchParams)) {
      throw new Error("expected URL-encoded Chutes refresh request");
    }
    expect(body.get("client_id")).toBe("cid_env");
    return jsonResponse({ access_token: "at_new", expires_in: 1800 });
  });
  const refreshed = await refreshWithFetch(fetchFn, { clientId: undefined });
  expect(refreshed.clientId).toBe("cid_env");
  expect(refreshed.refresh).toBe("rt_old");
});

it("requires a refresh token", async () => {
  await expect(
    refreshChutesOAuthCredential(createStoredCredential({ refresh: "" })),
  ).rejects.toThrow("Chutes OAuth credential is missing refresh token");
});

it("requires a client id from the credential or environment", async () => {
  vi.stubEnv("CHUTES_CLIENT_ID", "");
  await expect(
    refreshChutesOAuthCredential(createStoredCredential({ clientId: undefined })),
  ).rejects.toThrow("Missing CHUTES_CLIENT_ID for Chutes OAuth refresh (set env var or re-auth).");
});

it("rejects missing access tokens", async () => {
  const fetchFn = vi.fn(async () => jsonResponse({ expires_in: 1800 }));
  await expect(refreshWithFetch(fetchFn)).rejects.toThrow(
    "Chutes token refresh returned no access_token",
  );
});
