import { createHash } from "node:crypto";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterOAuthAuthMethod } from "./oauth.js";

const REDIRECT_URI = "http://localhost:3000/openrouter-oauth/callback";
const AUTH_URL = "https://openrouter.ai/auth";
const DENIED_ERROR = "OpenRouter OAuth error: access_denied: Denied";
const releaseGuard = vi.fn(async () => undefined);
type OpenRouterOAuthLoginOptions = {
  createPkce?: typeof providerAuth.generatePkceVerifierChallenge;
  createState?: typeof providerAuthRuntime.generateOAuthState;
  fetchImpl?: typeof fetch;
  startCallback?: typeof providerAuthRuntime.startProviderOAuthLoopbackCallbackServer;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  releaseGuard.mockClear();
});

function login(ctx: ProviderAuthContext, options: OpenRouterOAuthLoginOptions = {}) {
  if (options.createPkce) {
    vi.spyOn(providerAuth, "generatePkceVerifierChallenge").mockImplementation(options.createPkce);
  }
  if (options.createState) {
    vi.spyOn(providerAuthRuntime, "generateOAuthState").mockImplementation(options.createState);
  }
  if (options.startCallback) {
    vi.spyOn(providerAuthRuntime, "startProviderOAuthLoopbackCallbackServer").mockImplementation(
      options.startCallback,
    );
  }
  const fetchImpl = options.fetchImpl;
  if (fetchImpl) {
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(
      async ({ url, init, beforeRequest }) => {
        beforeRequest?.();
        return { response: await fetchImpl(url, init), finalUrl: url, release: releaseGuard };
      },
    );
  }
  return createOpenRouterOAuthAuthMethod().run(ctx);
}

const fixturePkce = () => ({ verifier: "verifier-1", challenge: "challenge-1" });
const fixtureState = () => "state-1";
const redirectUrl = (query: string) => `${REDIRECT_URI}?${query}`;
function successFetch(key = "sk-or-v1-test") {
  return vi.fn<typeof fetch>(async () => Response.json({ key }));
}

function fixtureLogin(ctx: ProviderAuthContext, options: OpenRouterOAuthLoginOptions = {}) {
  return login(ctx, { createPkce: fixturePkce, createState: fixtureState, ...options });
}

function callbackServer(
  waitForCallback: Awaited<
    ReturnType<NonNullable<OpenRouterOAuthLoginOptions["startCallback"]>>
  >["waitForCallback"],
  close = vi.fn(async () => undefined),
) {
  return { waitForCallback, complete: async () => undefined, close };
}

function localCallback(wait: Parameters<typeof callbackServer>[0]) {
  const context = oauthContext({ isRemote: false });
  const waitForCallback = vi.fn(wait);
  const close = vi.fn(async () => undefined);
  const startCallback = vi.fn(async () => callbackServer(waitForCallback, close));
  const fetchImpl = successFetch();
  return {
    ...context,
    waitForCallback,
    close,
    startCallback,
    fetchImpl,
    run: () => fixtureLogin(context.ctx, { fetchImpl, startCallback }),
  };
}

function boundedTextErrorResponse(body: string) {
  const chunks = [
    { done: false, value: new TextEncoder().encode(body) },
    { done: true, value: undefined },
  ];
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const text = vi.fn(async () => {
    throw new Error("response.text() should not be called");
  });
  const response = {
    ok: false,
    status: 502,
    headers: new Headers(),
    body: { getReader: () => ({ read: async () => chunks.shift(), cancel, releaseLock }) },
    text,
  } as unknown as Response;

  return { response, cancel, releaseLock, text };
}

function requestJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function oauthContext(
  params: {
    isRemote?: boolean;
    onProgress?: (message: string) => void;
    redirectInput?: string;
  } = {},
) {
  const progress = {
    update: vi.fn((message: string) => params.onProgress?.(message)),
    stop: vi.fn(),
  };
  const note = vi.fn(async (_message: string, _title?: string) => undefined);
  const text = vi.fn<ProviderAuthContext["prompter"]["text"]>(
    async () => params.redirectInput ?? redirectUrl("state=state-1&code=AUTHCODE"),
  );
  const log = vi.fn<(message: string) => void>();
  const openUrl = vi.fn(async (_url: string) => undefined);
  const ctx = {
    config: {},
    isRemote: params.isRemote ?? true,
    openUrl,
    prompter: { note, text, progress: vi.fn(() => progress) },
    runtime: { log, error: vi.fn(), exit: vi.fn() },
    oauth: { createVpsAwareHandlers: vi.fn() },
  } as unknown as ProviderAuthContext;

  return { ctx, progress, note, text, log, openUrl };
}

function loginRedirect(redirectInput: string) {
  const { ctx } = oauthContext({ redirectInput });
  return fixtureLogin(ctx, { fetchImpl: successFetch() });
}

function exchange(response: Response, badCode = false) {
  const { ctx } = oauthContext({
    redirectInput: redirectUrl(`state=state-1&code=${badCode ? "bad-code" : "AUTHCODE"}`),
  });
  return fixtureLogin(ctx, {
    ...(badCode
      ? { createPkce: () => ({ verifier: "bad-verifier", challenge: "challenge-1" }) }
      : {}),
    fetchImpl: async () => response,
  });
}

function expectAuthorizationUrl(value: string, redirect = REDIRECT_URI) {
  const url = new URL(value);
  const callback = new URL(url.searchParams.get("callback_url") ?? "");
  expect(url.origin + url.pathname).toBe(AUTH_URL);
  expect(callback.origin + callback.pathname).toBe(redirect);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ code_challenge_method: "S256" });
  return { url, callback };
}

function credential(key: string, userId?: string) {
  return {
    type: "api_key",
    provider: "openrouter",
    key,
    metadata: { authFlow: "oauth-pkce", ...(userId ? { userId } : {}) },
    ...(userId ? { displayName: `OpenRouter ${userId}` } : {}),
  };
}

describe("OpenRouter OAuth", () => {
  it("uses hosted authorization without a manual prompt or loopback", async () => {
    const { ctx, note, text, log, openUrl } = oauthContext();
    const hostedRedirectUrl = "https://gateway.example.com/auth/callback?flow=hosted-1";
    const authorizationUrls: URL[] = [];
    const authorize = vi.fn<NonNullable<ProviderAuthContext["oauth"]["authorize"]>>(
      async ({ state, timeoutMs, buildAuthorizationUrl }) => {
        expect(state).not.toBe("");
        expect(timeoutMs).toBe(5 * 60 * 1000);
        const { url, callback } = expectAuthorizationUrl(
          buildAuthorizationUrl(hostedRedirectUrl),
          "https://gateway.example.com/auth/callback",
        );
        expect(Object.fromEntries(callback.searchParams)).toMatchObject({
          flow: "hosted-1",
          state,
        });
        authorizationUrls.push(url);
        return { code: "HOSTEDCODE", state };
      },
    );
    ctx.oauth.authorize = authorize;
    const startCallback = vi.fn(async () => {
      throw new Error("Hosted sign-in must not open a loopback listener");
    });
    const fetchImpl = successFetch("hosted-api-key");

    const result = await login(ctx, { createState: fixtureState, fetchImpl, startCallback });

    expect(authorize).toHaveBeenCalledTimes(1);
    for (const unused of [startCallback, text, note, log, openUrl]) {
      expect(unused).not.toHaveBeenCalled();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ssrfRuntime.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "trusted_env_proxy" }),
    );
    expect(releaseGuard).toHaveBeenCalledTimes(1);
    const [exchangeUrl, exchangeInit] = fetchImpl.mock.calls[0]!;
    expect(exchangeUrl instanceof Request ? exchangeUrl.url : String(exchangeUrl)).toBe(
      "https://openrouter.ai/api/v1/auth/keys",
    );
    expect(exchangeInit?.method).toBe("POST");
    expect(new Headers(exchangeInit?.headers).get("content-type")).toBe("application/json");
    const exchangeBody = requestJsonBody(exchangeInit);
    expect(exchangeBody).toEqual({
      code: "HOSTEDCODE",
      code_verifier: expect.any(String),
      code_challenge_method: "S256",
    });
    const verifier = exchangeBody.code_verifier;
    if (typeof verifier !== "string") {
      throw new Error("Expected a PKCE verifier");
    }
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(authorizationUrls[0]?.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(result.profiles).toMatchObject([
      { profileId: "openrouter:default", credential: credential("hosted-api-key") },
    ]);
  });

  it("keeps malformed manual input correctable in the registered OAuth method", async () => {
    const { ctx, text } = oauthContext();
    const fetchImpl = successFetch("fixture-key");
    text.mockImplementationOnce(async ({ validate }) => {
      for (const value of [
        "chrome-error://chromewebdata/",
        "AUTHCODE",
        "code=AUTHCODE",
        "state=other&code=AUTHCODE",
      ]) {
        expect(validate?.(value)).toEqual(expect.any(String));
        expect(fetchImpl).not.toHaveBeenCalled();
      }
      const input = redirectUrl("state=state-1&code=AUTHCODE");
      expect(validate?.(input)).toBeUndefined();
      return input;
    });
    await expect(login(ctx, { createState: fixtureState, fetchImpl })).resolves.toMatchObject({
      profiles: [{ credential: { key: "fixture-key" } }],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("parses state-bound OpenRouter redirect URLs and query strings", async () => {
    for (const input of [
      redirectUrl("state=state-1&code=AUTHCODE"),
      "state=state-1&code=AUTHCODE",
    ]) {
      await expect(loginRedirect(input)).resolves.toMatchObject({
        defaultModel: "openrouter/auto",
      });
    }
    const denied = "state=state-1&error=access_denied&error_description=Denied";
    const missing = "Missing OpenRouter OAuth state";
    const mismatch = "OpenRouter OAuth state mismatch";
    for (const [input, error] of [
      [redirectUrl(denied), DENIED_ERROR],
      [denied, DENIED_ERROR],
      [redirectUrl("error=access_denied&error_description=Denied"), missing],
      [redirectUrl("state=wrong&error=access_denied&error_description=Denied"), mismatch],
      [redirectUrl("code=AUTHCODE"), missing],
      [redirectUrl("state=wrong&code=AUTHCODE"), mismatch],
      ["AUTHCODE", "Paste the full OpenRouter redirect URL"],
    ] as const) {
      await expect(loginRedirect(input)).rejects.toThrow(error);
    }
  });

  it("bounds successful OpenRouter OAuth responses", async () => {
    const oversized = oversizedJsonResponse({ chunkCount: 2, chunkSize: 16 * 1024 * 1024 + 10 });
    await expect(exchange(oversized.response)).rejects.toThrow(
      "OpenRouter OAuth key exchange: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.wasCanceled()).toBe(true);
    expect(releaseGuard).toHaveBeenCalledTimes(1);
  });

  it("surfaces OpenRouter OAuth exchange errors without credential material", async () => {
    for (const { status, error, message } of [
      {
        status: 403,
        error: "Invalid code or code_verifier",
        message: "Invalid code or code_verifier",
      },
      { status: 400, error: { message: "Invalid code", code: 400 }, message: "Invalid code" },
    ]) {
      await expect(exchange(Response.json({ error }, { status }), true)).rejects.toThrow(
        `OpenRouter OAuth key exchange failed (${status}): ${message}`,
      );
    }
  });

  it("bounds OpenRouter OAuth exchange error bodies without requiring response.text()", async () => {
    const errorResponse = boundedTextErrorResponse(
      `${"openrouter denied ".repeat(1024)}tail-marker`,
    );
    const error: unknown = await exchange(errorResponse.response, true).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("OpenRouter OAuth key exchange failed (502): openrouter denied");
    expect(message).not.toContain("tail-marker");
    expect(errorResponse.text).not.toHaveBeenCalled();
    expect(errorResponse.cancel).toHaveBeenCalledTimes(1);
    expect(errorResponse.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("returns a browser credential without claiming persistence", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ key: "sk-or-v1-test", user_id: "user-1" }),
    );
    const { ctx, progress, note, text, log, openUrl } = oauthContext();

    const result = await fixtureLogin(ctx, { fetchImpl });

    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining(`${AUTH_URL}?`));
    const openedUrl = openUrl.mock.calls[0]?.[0];
    if (typeof openedUrl !== "string") {
      throw new Error("expected OpenRouter OAuth authorize URL");
    }
    const { url, callback: callbackUrl } = expectAuthorizationUrl(openedUrl);
    expect(callbackUrl.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(log.mock.calls[0]?.[0]).toContain(`${AUTH_URL}?`);
    expect(note).toHaveBeenCalledWith(expect.stringContaining(`${AUTH_URL}?`), "OpenRouter OAuth");
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Paste the OpenRouter redirect URL" }),
    );
    expect(result.defaultModel).toBe("openrouter/auto");
    expect(result.profiles).toEqual([
      {
        profileId: "openrouter:default",
        credential: credential("sk-or-v1-test", "user-1"),
      },
    ]);
    expect(progress.stop).toHaveBeenCalledWith("OpenRouter credential received");
  });

  it("binds the local callback before opening the browser and exchanges its accepted code", async () => {
    const { run, startCallback, openUrl, waitForCallback, close, fetchImpl, text } = localCallback(
      async () => ({
        type: "authorization_code" as const,
        code: "AUTHCODE",
        state: "state-1",
        parameters: new URLSearchParams({ code: "AUTHCODE", state: "state-1" }),
      }),
    );
    await run();

    expect(startCallback).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: "state-1", redirectUrl: REDIRECT_URI }),
    );
    expect(startCallback.mock.invocationCallOrder[0]).toBeLessThan(
      openUrl.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(waitForCallback).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining(`${AUTH_URL}?`));
    expect(text).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestJsonBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      code: "AUTHCODE",
      code_verifier: "verifier-1",
      code_challenge_method: "S256",
    });
  });

  it("closes a state-bound provider denial without exchanging a code", async () => {
    const { run, startCallback, waitForCallback, close, fetchImpl, text } = localCallback(
      async () => ({
        type: "oauth_error" as const,
        error: "access_denied",
        errorDescription: "Denied",
      }),
    );
    await expect(run()).rejects.toThrow(DENIED_ERROR);

    expect(startCallback).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: "state-1" }),
    );
    expect(waitForCallback).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it.each(["progress", "log"])(
    "closes the local callback when %s reporting throws before waiting",
    async (reporter) => {
      const failure = new Error(`${reporter} reporter failed`);
      const fail = () => {
        throw failure;
      };
      const { ctx, log } = oauthContext({
        isRemote: false,
        ...(reporter === "progress" ? { onProgress: fail } : {}),
      });
      if (reporter === "log") {
        log.mockImplementation(fail);
      }
      const waitForCallback = vi.fn();
      const close = vi.fn(async () => undefined);
      await expect(
        login(ctx, {
          createState: fixtureState,
          startCallback: async () => callbackServer(waitForCallback, close),
        }),
      ).rejects.toThrow(failure.message);
      expect(waitForCallback).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("falls back to a pasted redirect when the local listener cannot start", async () => {
    const fetchImpl = successFetch();
    const startCallback = vi.fn(async () => {
      throw new Error("listen EADDRINUSE: address already in use localhost:3000");
    });
    const { ctx, openUrl, text } = oauthContext({ isRemote: false });

    await expect(fixtureLogin(ctx, { fetchImpl, startCallback })).resolves.toMatchObject({
      defaultModel: "openrouter/auto",
    });

    expect(startCallback).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Paste the OpenRouter redirect URL" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("closes a failed callback before falling back to a pasted redirect", async () => {
    const { run, text, close } = localCallback(async () => {
      throw new Error("OAuth callback timeout");
    });
    text.mockImplementationOnce(async () => {
      expect(close).toHaveBeenCalledOnce();
      return redirectUrl("state=state-1&code=AUTHCODE");
    });
    await expect(run()).resolves.toMatchObject({
      profiles: [{ credential: { key: "sk-or-v1-test" } }],
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
