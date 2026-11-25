import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import * as oauth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as oauthRuntime from "openclaw/plugin-sdk/provider-oauth-runtime";
import * as ssrf from "openclaw/plugin-sdk/ssrf-runtime";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenRouterOAuthAuthMethod } from "./oauth.js";

const REDIRECT = "http://localhost:3000/openrouter-oauth/callback";
const AUTH = "https://openrouter.ai/auth";
const DENIED = "Sign-in was not allowed. Go back to the sign-in page and allow access.";
const WRONG_ATTEMPT = "This address belongs to a different sign-in attempt.";
const realPkce = providerAuth.generatePkceVerifierChallenge;
const fetchImpl = vi.fn<typeof fetch>();
const wait = vi.fn<typeof oauth.waitForLocalOAuthCallback>();
const release = vi.fn(async () => undefined);
const redirect = (query = "state=state-1&code=AUTHCODE") => `${REDIRECT}?${query}`;
const login = (ctx: ProviderAuthContext) => createOpenRouterOAuthAuthMethod().run(ctx);

beforeEach(() => {
  fetchImpl.mockReset().mockImplementation(async () => Response.json({ key: "fixture-key" }));
  wait.mockReset();
  vi.spyOn(providerAuth, "generatePkceVerifierChallenge").mockReturnValue({
    verifier: "verifier-1",
    challenge: "challenge-1",
  });
  vi.spyOn(oauthRuntime, "generateOAuthState").mockReturnValue("state-1");
  vi.spyOn(oauth, "waitForLocalOAuthCallback").mockImplementation(wait);
  vi.spyOn(ssrf, "fetchWithSsrFGuard").mockImplementation(async ({ url, init, beforeRequest }) => {
    beforeRequest?.();
    return { response: await fetchImpl(url, init), finalUrl: url, release };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  release.mockClear();
});

function context(isRemote = true, input = redirect()) {
  const progress = { update: vi.fn(), stop: vi.fn() };
  const text = vi.fn<ProviderAuthContext["prompter"]["text"]>(async () => input);
  const note = vi.fn(async () => undefined);
  const log = vi.fn<(message: string) => void>();
  const openUrl = vi.fn(async (_url: string) => undefined);
  const ctx = {
    config: {},
    isRemote,
    openUrl,
    prompter: { text, note, progress: () => progress },
    runtime: { log, error: vi.fn(), exit: vi.fn() },
    oauth: { createVpsAwareHandlers: vi.fn() },
  } as unknown as ProviderAuthContext;
  return { ctx, progress, text, note, log, openUrl };
}
function local(callback: typeof oauth.waitForLocalOAuthCallback) {
  const fixture = context(false);
  wait.mockImplementation(callback);
  return { ...fixture, run: () => login(fixture.ctx) };
}
function requestBody() {
  const body = fetchImpl.mock.calls[0]?.[1]?.body;
  assert(typeof body === "string", "Expected JSON request body");
  return JSON.parse(body) as Record<string, unknown>;
}
function authUrl(value: string, target = REDIRECT) {
  const url = new URL(value);
  const callback = new URL(url.searchParams.get("callback_url") ?? "");
  expect(url.origin + url.pathname).toBe(AUTH);
  expect(callback.origin + callback.pathname).toBe(target);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  return { url, callback };
}
function exchange(response: Response) {
  fetchImpl.mockResolvedValueOnce(response);
  return login(context().ctx);
}

it("uses hosted authorization with real PKCE and no manual prompt or loopback", async () => {
  vi.mocked(providerAuth.generatePkceVerifierChallenge).mockImplementation(realPkce);
  fetchImpl.mockResolvedValueOnce(Response.json({ key: "fixture-key", user_id: "user-1" }));
  const { ctx, text, note, log, openUrl } = context();
  let challenge: string | null = null;
  ctx.oauth.authorize = async ({ state, timeoutMs, buildAuthorizationUrl }) => {
    expect(state).not.toBe("");
    expect(timeoutMs).toBe(5 * 60 * 1000);
    const { url, callback } = authUrl(
      buildAuthorizationUrl("https://gateway.example.com/auth/callback?flow=hosted-1"),
      "https://gateway.example.com/auth/callback",
    );
    expect(Object.fromEntries(callback.searchParams)).toEqual({ flow: "hosted-1", state });
    challenge = url.searchParams.get("code_challenge");
    return { code: "HOSTEDCODE", state };
  };
  expect((await login(ctx)).profiles).toMatchObject([
    {
      profileId: "openrouter:default",
      credential: {
        type: "api_key",
        provider: "openrouter",
        key: "fixture-key",
        displayName: "OpenRouter user-1",
        metadata: { authFlow: "oauth-pkce", userId: "user-1" },
      },
    },
  ]);
  for (const unused of [wait, text, note, log, openUrl]) {
    expect(unused).not.toHaveBeenCalled();
  }
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/auth/keys");
  expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("content-type")).toBe(
    "application/json",
  );
  expect(ssrf.fetchWithSsrFGuard).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "trusted_env_proxy" }),
  );
  const body = requestBody();
  expect(body).toEqual({
    code: "HOSTEDCODE",
    code_verifier: expect.any(String),
    code_challenge_method: "S256",
  });
  const verifier = body.code_verifier;
  assert(typeof verifier === "string");
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  expect(release).toHaveBeenCalledOnce();
});

it("keeps malformed manual input correctable before exchanging a credential", async () => {
  const { ctx, text } = context();
  text.mockImplementationOnce(async ({ validate }) => {
    for (const value of [
      "chrome-error://chromewebdata/",
      "state=other&code=AUTHCODE",
      `${AUTH}?callback_url=${encodeURIComponent(REDIRECT)}`,
      redirect("state=state-1&error=access_denied"),
    ]) {
      expect(validate?.(value)).toEqual(expect.any(String));
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    expect(validate?.(redirect())).toBeUndefined();
    return redirect();
  });
  expect((await login(ctx)).profiles).toMatchObject([{ credential: { key: "fixture-key" } }]);
});

it.each([
  [redirect(), undefined],
  ["AUTHCODE", undefined],
  [redirect("state=wrong&code=AUTHCODE"), WRONG_ATTEMPT],
  [redirect("error=access_denied&error_description=Denied"), DENIED],
])("checks the pasted redirect %s against the state inside callback_url", async (input, error) => {
  const result = login(context(true, input).ctx);
  if (error) {
    await expect(result).rejects.toThrow(error);
    expect(fetchImpl).not.toHaveBeenCalled();
  } else {
    await expect(result).resolves.toMatchObject({ defaultModel: "openrouter/auto" });
  }
});

it("bounds successful OAuth response bodies and releases transport", async () => {
  const oversized = oversizedJsonResponse({ chunkCount: 2, chunkSize: 16 * 1024 * 1024 + 10 });
  await expect(exchange(oversized.response)).rejects.toThrow(
    "JSON response exceeds 16777216 bytes",
  );
  expect(oversized.wasCanceled()).toBe(true);
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  [403, "Invalid code or code_verifier", "Invalid code or code_verifier"],
  [400, { message: "Invalid code", code: 400 }, "Invalid code"],
] as const)("surfaces HTTP %s exchange errors", async (status, error, message) => {
  await expect(exchange(Response.json({ error }, { status }))).rejects.toThrow(
    `OpenRouter OAuth key exchange failed (${status}): ${message}`,
  );
});

it("bounds plain-text OAuth error bodies without response.text()", async () => {
  const response = new Response(`${"openrouter denied ".repeat(1024)}tail-marker`, { status: 502 });
  const reader = response.body!.getReader();
  const cancel = vi.spyOn(reader, "cancel");
  const releaseLock = vi.spyOn(reader, "releaseLock");
  vi.spyOn(response.body!, "getReader").mockReturnValue(reader);
  const text = vi.spyOn(response, "text");
  const error: unknown = await exchange(response).catch((caught: unknown) => caught);
  assert(error instanceof Error);
  expect(error.message).toContain("OpenRouter OAuth key exchange failed (502): openrouter denied");
  expect(error.message).not.toContain("tail-marker");
  expect(text).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(releaseLock).toHaveBeenCalledOnce();
});

it("exchanges the local callback code and keeps listening after a refusal", async () => {
  const { run, openUrl, text, progress } = local(async (params) => {
    // Core keeps the listener open after a refusal and reports it as progress.
    params.onProgress?.(DENIED, "consent_denied");
    return { code: "AUTHCODE", state: "state-1" };
  });
  await run();
  expect(wait).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedState: "state-1",
      port: 3000,
      callbackPath: "/openrouter-oauth/callback",
      redirectUri: REDIRECT,
      onProgress: expect.any(Function),
    }),
  );
  expect(progress.update).toHaveBeenCalledWith(DENIED, "consent_denied");
  const { url, callback } = authUrl(openUrl.mock.calls[0]![0]);
  expect(callback.searchParams.get("state")).toBe("state-1");
  expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
  expect(text).not.toHaveBeenCalled();
  expect(requestBody()).toEqual({
    code: "AUTHCODE",
    code_verifier: "verifier-1",
    code_challenge_method: "S256",
  });
});

it.each([
  [
    Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
    ["The sign-in callback could not start because its port is in use.", "callback_port_busy"],
  ],
  [
    new Error("OAuth callback timeout"),
    ["OAuth callback not detected; waiting for redirect URL..."],
  ],
])("falls back to a pasted redirect after %s", async (failure, update) => {
  const { run, openUrl, text, progress } = local(async () => {
    throw failure;
  });
  await expect(run()).resolves.toMatchObject({ defaultModel: "openrouter/auto" });
  expect(progress.update).toHaveBeenCalledWith(...update);
  if (update[1]) {
    // A busy port is said once the paste prompt is open, so setup apps show it beside it.
    expect(progress.update.mock.invocationCallOrder.at(-2)).toBeGreaterThan(
      text.mock.invocationCallOrder[0]!,
    );
  }
  expect(openUrl).toHaveBeenCalledOnce();
  expect(text).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Paste the OpenRouter redirect URL" }),
  );
});
