import { once } from "node:events";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { loginChutes, refreshChutesOAuthCredential as refreshChutes } from "./oauth.js";

const CHUTES_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
const CHUTES_USERINFO_ENDPOINT = "https://api.chutes.ai/idp/userinfo";
const REDIRECT_URI = "http://127.0.0.1:1456/oauth-callback";
const access = "at_123";
const refresh = "rt_123";
const waitForLocalOAuthCallbackMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  waitForLocalOAuthCallback: waitForLocalOAuthCallbackMock,
}));

function streamingResponse(body: string, status: number, keepOpen = false) {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
      },
      pull(controller) {
        if (!keepOpen) {
          controller.close();
        }
      },
      cancel,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
  return { response, cancel };
}

function mockFetch(
  token = jsonResponse({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
  userInfo = async (_init?: RequestInit) => new Response("not found", { status: 404 }),
) {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url === CHUTES_TOKEN_ENDPOINT) {
      return token;
    }
    return url === CHUTES_USERINFO_ENDPOINT
      ? await userInfo(init)
      : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

async function rejectWhenAborted(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  if (!signal) {
    throw new Error("missing OAuth request signal");
  }
  signal.throwIfAborted();
  await once(signal, "abort");
  throw signal.reason;
}

function login(overrides: Partial<Parameters<typeof loginChutes>[0]> = {}) {
  let state = "";
  return loginChutes({
    app: { clientId: "cid_test", redirectUri: REDIRECT_URI, scopes: ["openid"] },
    manual: true,
    onAuth: async ({ url }) => {
      state = new URL(url).searchParams.get("state") ?? "";
    },
    onPrompt: async () => `${REDIRECT_URI}?code=code_test&state=${state}`,
    ...overrides,
  });
}

const stored: OAuthCredential = {
  type: "oauth",
  provider: "chutes",
  access: "at_old",
  refresh: "rt_old",
  expires: 1_000_000,
  clientId: "cid_stored",
  email: "fred@example.com",
};

afterEach(() => {
  waitForLocalOAuthCallbackMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.resetModules();
});

it("uses an IPv6 loopback callback without changing the OAuth redirect URI", async () => {
  const redirectUri = "http://[::1]:1456/oauth-callback";
  waitForLocalOAuthCallbackMock.mockResolvedValue({ code: "code_test", state: "state_test" });
  const fetchFn = mockFetch();
  await expect(
    login({
      app: { clientId: "cid_test", redirectUri, scopes: ["openid"] },
      manual: false,
      onPrompt: async () => {
        throw new Error("IPv6 callback must not require manual fallback");
      },
    }),
  ).resolves.toMatchObject({ access, refresh });
  expect(waitForLocalOAuthCallbackMock).toHaveBeenCalledWith(
    expect.objectContaining({ hostname: "::1", port: 1456, redirectUri }),
  );
  const tokenRequest = fetchFn.mock.calls[0]?.[1]?.body;
  expect((tokenRequest as URLSearchParams).get("redirect_uri")).toBe(redirectUri);
});

it.each([
  [true, REDIRECT_URI, "not a URL", "Paste the full redirect URL (must include code + state)."],
  [true, REDIRECT_URI, `${REDIRECT_URI}?code=code_test`, "Missing 'state' parameter."],
  [true, REDIRECT_URI, `${REDIRECT_URI}?code=code_test&state=wrong`, "OAuth state mismatch"],
  [false, "https://127.0.0.1:1456/oauth-callback", "", "redirect URI must be http://"],
  [false, "http://example.com/oauth-callback", "", "redirect hostname must be loopback"],
] as const)("rejects invalid callback: %s %s %s", async (manual, redirectUri, input, message) => {
  const fetchFn = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchFn);
  await expect(
    login({
      app: { clientId: "cid_test", redirectUri, scopes: ["openid"] },
      manual,
      onPrompt: async () => input,
    }),
  ).rejects.toThrow(message);
  expect(fetchFn).not.toHaveBeenCalled();
  expect(waitForLocalOAuthCallbackMock).not.toHaveBeenCalled();
});

it.each([
  ['{"access_token":"at","expires_in":1e309}', "invalid expires_in", "exchange"],
  ['{"expires_in":1800}', "no access_token", "refresh"],
])("rejects invalid token response: %s", async (body, message, phase) => {
  mockFetch(new Response(body, { headers: { "Content-Type": "application/json" } }));
  await expect(phase === "exchange" ? login() : refreshChutes(stored)).rejects.toThrow(
    `Chutes token ${phase} returned ${message}`,
  );
});

it("bounds and redacts token exchange error bodies", async () => {
  const leakedClientSecret = "oauth-client-secret-1234567890";
  const stream = streamingResponse(
    `${`client_secret=${leakedClientSecret}&reason=unavailable `.repeat(1024)}tail-marker`,
    502,
    true,
  );
  const fetchFn = mockFetch(stream.response);
  const error = await login().catch((caught: unknown) => caught);
  const message = (error as Error).message;
  expect(error).toMatchObject({ name: "ProviderHttpError", status: 502 });
  expect(message).not.toContain(leakedClientSecret);
  expect(message).not.toContain("tail-marker");
  expect((error as { errorBody?: string }).errorBody).not.toContain(leakedClientSecret);
  expect(stream.cancel).toHaveBeenCalledTimes(1);
  expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("keeps issued tokens when userinfo exceeds the fixed deadline", async () => {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    expect(delay).toBe(30_000);
    return AbortSignal.abort(new DOMException("OAuth request timed out", "TimeoutError"));
  });
  mockFetch(undefined, rejectWhenAborted);
  expect(await login()).toMatchObject({ access, refresh, email: undefined, accountId: undefined });
});

it("cancels the userinfo error response body when profile lookup fails", async () => {
  const userInfoResponse = streamingResponse("temporarily unavailable", 503);
  mockFetch(undefined, async () => userInfoResponse.response);
  expect(await login()).toMatchObject({ access, email: undefined, accountId: undefined });
  expect(userInfoResponse.cancel).toHaveBeenCalledOnce();
});

it("cancels authentication when the caller aborts during userinfo", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");
  mockFetch(undefined, async (init) => {
    controller.abort(reason);
    return await rejectWhenAborted(init);
  });
  await expect(login({ signal: controller.signal })).rejects.toBe(reason);
});

it.each([
  { clientId: "cid_stored", next: "rt_new", secret: "secret_env" },
  { clientId: undefined, next: undefined, secret: "" },
])("refreshes $clientId / $next", async ({ clientId, next, secret }) => {
  vi.stubEnv("CHUTES_CLIENT_ID", "cid_env");
  vi.stubEnv("CHUTES_CLIENT_SECRET", secret);
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  const fetchFn = mockFetch(
    jsonResponse({ access_token: "at_new", refresh_token: next, expires_in: 1800 }),
  );
  vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  await expect(refreshChutes({ ...stored, clientId })).resolves.toEqual({
    ...stored,
    clientId: clientId ?? "cid_env",
    access: "at_new",
    refresh: next ?? "rt_old",
    expires: 3_500_000,
  });
  const request = fetchFn.mock.calls[0]?.[1];
  expect(request?.method).toBe("POST");
  const contentType = new Headers(request?.headers).get("content-type");
  expect(contentType).toBe("application/x-www-form-urlencoded");
  expect(Object.fromEntries(request?.body as URLSearchParams)).toEqual({
    grant_type: "refresh_token",
    client_id: clientId ?? "cid_env",
    refresh_token: "rt_old",
    ...(secret ? { client_secret: secret } : {}),
  });
  expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(30_000);
  expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it.each<[Partial<OAuthCredential>, string]>([
  [{ refresh: "" }, "Chutes OAuth credential is missing refresh token"],
  [{ clientId: undefined }, "Missing CHUTES_CLIENT_ID"],
])("rejects invalid refresh credentials: %j", async (overrides, message) => {
  vi.stubEnv("CHUTES_CLIENT_ID", "");
  await expect(refreshChutes({ ...stored, ...overrides })).rejects.toThrow(message);
});
