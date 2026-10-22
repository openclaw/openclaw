import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { loginChutes, refreshChutesOAuthCredential as refreshChutes } from "./oauth.js";

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

function chunkedResponse(body: string | Uint8Array, chunks: number | null, status: number) {
  const chunk = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const trace = { bytesPulled: 0, cancel: vi.fn() };
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (chunks === null) {
          controller.enqueue(chunk);
        }
      },
      pull(controller) {
        if (chunks === null) {
          return; // Leave the error stream open until cancellation.
        }
        if (trace.bytesPulled >= chunks * chunk.length) {
          controller.close();
          return;
        }
        trace.bytesPulled += chunk.length;
        controller.enqueue(chunk);
      },
      cancel: trace.cancel,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
  return { response, trace };
}

function oauthFetch({
  token = jsonResponse({ access_token: "at_123", refresh_token: "rt_123", expires_in: 3600 }),
  userInfo = async () => new Response("not found", { status: 404 }),
}: {
  token?: Response;
  userInfo?: (init?: RequestInit) => Promise<Response>;
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url === CHUTES_TOKEN_ENDPOINT) {
      return token;
    }
    return url === CHUTES_USERINFO_ENDPOINT
      ? await userInfo(init)
      : new Response("not found", { status: 404 });
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
  return refreshChutes({ ...stored, ...overrides });
}

const stored: OAuthCredential = {
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
};

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
  const stream = chunkedResponse(
    `${`client_secret=${leakedClientSecret}&reason=unavailable `.repeat(1024)}tail-marker`,
    null,
    502,
  );
  const releaseLock = vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock");
  const text = vi.spyOn(stream.response, "text").mockRejectedValue(new Error("unexpected text()"));
  const fetchFn = oauthFetch({ token: stream.response });
  const error = await loginWithFetch(fetchFn).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(error).toMatchObject({ name: "ProviderHttpError", status: 502 });
  expect(message).toContain("Chutes token exchange failed (502): client_secret=");
  expect(message).not.toContain(leakedClientSecret);
  expect(message).not.toContain("tail-marker");
  expect((error as { errorBody?: string }).errorBody).not.toContain(leakedClientSecret);
  expect(text).not.toHaveBeenCalled();
  expect(stream.trace.cancel).toHaveBeenCalledTimes(1);
  expect(releaseLock).toHaveBeenCalledTimes(1);
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
  expect(oversizedTokenJson.trace.cancel).toHaveBeenCalledOnce();
  expect(oversizedTokenJson.trace.bytesPulled).toBeLessThan(32 * 1024 * 1024);
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
  const userInfoResponse = chunkedResponse("temporarily unavailable", 1, 503);
  const fetchFn = oauthFetch({ userInfo: async () => userInfoResponse.response });
  const credentials = await loginWithFetch(fetchFn);
  expect(userInfoResponse.trace.cancel).toHaveBeenCalledOnce();
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

it.each([
  { clientId: "cid_stored", refresh: "rt_new", secret: "secret_env" },
  { clientId: undefined, refresh: undefined, secret: "" },
])("refreshes $clientId / $refresh", async ({ clientId, refresh, secret }) => {
  vi.stubEnv("CHUTES_CLIENT_ID", "cid_env");
  vi.stubEnv("CHUTES_CLIENT_SECRET", secret);
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(requestUrl(input)).toBe(CHUTES_TOKEN_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      client_id: clientId ?? "cid_env",
      refresh_token: "rt_old",
      ...(secret ? { client_secret: secret } : {}),
    });
    return jsonResponse({ access_token: "at_new", refresh_token: refresh, expires_in: 1800 });
  });
  const now = 2_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  await expect(refreshWithFetch(fetchFn, { clientId })).resolves.toEqual({
    ...stored,
    clientId: clientId ?? "cid_env",
    access: "at_new",
    refresh: refresh ?? "rt_old",
    expires: now + 1800 * 1000 - 5 * 60 * 1000,
  });
  expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(30_000);
  expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it.each<[Partial<OAuthCredential>, string]>([
  [{ refresh: "" }, "Chutes OAuth credential is missing refresh token"],
  [
    { clientId: undefined },
    "Missing CHUTES_CLIENT_ID for Chutes OAuth refresh (set env var or re-auth).",
  ],
])("rejects invalid refresh credentials: %j", async (overrides, message) => {
  vi.stubEnv("CHUTES_CLIENT_ID", "");
  await expect(refreshChutes({ ...stored, ...overrides })).rejects.toThrow(message);
});

it("rejects missing access tokens", async () => {
  await expect(
    refreshWithFetch(vi.fn(async () => jsonResponse({ expires_in: 1800 }))),
  ).rejects.toThrow("Chutes token refresh returned no access_token");
});
